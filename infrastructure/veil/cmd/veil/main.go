package main

import (
	"log"
	"net"
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
		ContextLength:      cfg.ContextLength,
		Timeout:            cfg.ModelTimeout,
	})
	if err != nil {
		log.Fatal(err)
	}

	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Handler:           httpapi.NewServer(cfg, modelClient),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("umbratic veil listening on %s", listener.Addr().String())
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
