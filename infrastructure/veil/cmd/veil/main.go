package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"umbratic-veil/internal/config"
	httpapi "umbratic-veil/internal/http"
	"umbratic-veil/internal/model"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	modelClient, err := model.NewClient(model.ClientConfig{
		Mode:          cfg.Mode,
		BaseURL:       cfg.ProviderBaseURL,
		ContextLength: cfg.ContextLength,
		Timeout:       cfg.ModelTimeout,
	})
	if err != nil {
		log.Fatal(err)
	}

	if len(os.Args) == 2 && os.Args[1] == "models" {
		ctx, cancel := context.WithTimeout(context.Background(), cfg.ModelTimeout)
		defer cancel()
		models, listErr := modelClient.ListModels(ctx)
		if listErr != nil {
			log.Fatal("model discovery failed")
		}
		if encodeErr := json.NewEncoder(os.Stdout).Encode(models); encodeErr != nil {
			log.Fatal("model discovery output failed")
		}
		return
	}

	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}

	api := httpapi.NewServer(cfg, modelClient)
	server := &http.Server{
		Handler:           api,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    64 * 1024,
	}

	// Warm up before accepting model work so a restart under load does not take
	// requests it cannot yet serve. Readiness also latches on the first
	// successful health check, so a slow runtime just delays readiness.
	go warmUp(api, cfg.ModelTimeout)

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	log.Printf("umbratic veil listening on %s", listener.Addr().String())
	select {
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-shutdown:
		// Refuse new model work first, then let in-flight streams finish within
		// the drain deadline instead of being cut mid-response.
		api.BeginDrain()
		log.Printf("umbratic veil draining for up to %s", drainTimeout)
		ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("umbratic veil drain ended early: %v", err)
		}
	}
}

const drainTimeout = 30 * time.Second

func warmUp(api *httpapi.Server, timeout time.Duration) {
	for attempt := 0; attempt < 30; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		err := api.Warm(ctx)
		cancel()
		if err == nil {
			log.Print("umbratic veil is ready")
			return
		}
		time.Sleep(time.Second)
	}
	log.Print("umbratic veil could not reach the model runtime during warm-up")
}
