package main

import (
	"log"
	"net/http"
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
		APIKey:             cfg.ProviderAPIKey,
		ContextLength:      cfg.ContextLength,
		Timeout:            cfg.ModelTimeout,
	})
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.NewServer(cfg, modelClient),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("umbratic veil listening on %s", cfg.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
