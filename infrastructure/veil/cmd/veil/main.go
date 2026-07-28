package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
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
		Protocol:           cfg.ProviderProtocol,
		BaseURL:            cfg.ProviderBaseURL,
		ChatEndpointPath:   cfg.ProviderChatEndpointPath,
		ModelsEndpointPath: cfg.ProviderModelsEndpointPath,
		ContextLength:      cfg.ContextLength,
		Timeout:            cfg.ModelTimeout,
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

	server := &http.Server{
		Handler:           httpapi.NewServer(cfg, modelClient),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    64 * 1024,
	}

	log.Printf("umbratic veil listening on %s", listener.Addr().String())
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
