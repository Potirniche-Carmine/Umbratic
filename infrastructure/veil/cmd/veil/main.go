package main

import (
	"context"
	"encoding/json"
	"io"
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

	specs := make([]model.RegistrySpec, 0, len(cfg.Models))
	for _, entry := range cfg.Models {
		specs = append(specs, model.RegistrySpec{
			ID:               entry.ID,
			BaseURL:          entry.ProviderBaseURL,
			ContextLength:    entry.ContextLength,
			Reasoning:        entry.Reasoning,
			SamplingProfiles: entry.SamplingProfiles,
			EmbeddingBaseURL: cfg.RAG.EmbeddingBaseURL,
			EmbeddingModel:   cfg.RAG.EmbeddingModel,
		})
	}
	modelClient, err := model.NewRegistry(cfg.Mode, cfg.DefaultModel, cfg.ProviderAPIKey, specs, cfg.ModelTimeout)
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
	watchParentStdin(shutdown)
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

// ParentStdinWatchEnv opts this process into exiting when its launcher does.
const ParentStdinWatchEnv = "VEIL_PARENT_STDIN_WATCH"

// watchParentStdin drains stdin and requests shutdown when it reaches EOF.
//
// A signal is only delivered when the launcher gets to ask politely. Electron
// force-killed by a dev script, or crashing, never runs its before-quit hook,
// and the Veil it started keeps listening — observed as five orphaned instances
// from five app launches, each holding its own port. An inherited stdin pipe
// closes no matter how the parent dies, which makes EOF the one signal that
// survives every exit path.
//
// Opt-in, because a Veil started by hand from a terminal has a stdin that never
// reaches EOF, and one started with stdin at /dev/null reaches it immediately.
// Only a launcher that actually holds the write end sets the variable.
func watchParentStdin(shutdown chan<- os.Signal) {
	if os.Getenv(ParentStdinWatchEnv) != "1" {
		return
	}
	go func() {
		// The launcher writes nothing; this blocks until the pipe closes.
		_, _ = io.Copy(io.Discard, os.Stdin)
		log.Printf("umbratic veil launcher closed stdin; shutting down")
		// Same path as a signal, so in-flight streams still drain.
		shutdown <- syscall.SIGTERM
	}()
}

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
