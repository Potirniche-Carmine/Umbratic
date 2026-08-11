package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/entitlement"
	"umbratic-veil-console/internal/rag"
	"umbratic-veil-console/internal/state"
	"umbratic-veil-console/internal/supervisor"
	"umbratic-veil-console/internal/web"
)

func main() {
	startup := config.Startup{}
	flag.StringVar(&startup.Listen, "listen", "127.0.0.1", "loopback listen address")
	flag.IntVar(&startup.Port, "port", 8177, "loopback listen port")
	flag.StringVar(&startup.StateDir, "state-dir", "/var/lib/veil-console", "Console state directory")
	flag.StringVar(&startup.VeilBinary, "veil-binary", "./veil", "fixed Veil executable path")
	flag.StringVar(&startup.VLLMBinary, "vllm-binary", "", "vLLM executable used to launch managed models")
	flag.StringVar(&startup.VeilAddress, "veil-address", "127.0.0.1:8080", "fixed loopback Veil address")
	flag.StringVar(&startup.EntitlementPath, "entitlement", "", "signed customer entitlement path")
	flag.StringVar(&startup.TrustedOrigin, "trusted-origin", "", "exact HTTPS reverse-proxy origin")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("positional arguments are not accepted")
	}
	if err := config.ValidateStartup(&startup); err != nil {
		log.Fatal(err)
	}
	if startup.EntitlementPath != "" {
		if _, err := entitlement.Load(startup.EntitlementPath); err != nil {
			log.Fatal(err)
		}
	}
	store, err := state.Open(startup.StateDir)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	secrets, err := store.LoadOrCreateSecrets()
	if err != nil {
		log.Fatal(err)
	}
	setup, err := store.IsSetup(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	if !setup {
		code, err := store.NewSetup(context.Background(), time.Now())
		if err != nil {
			log.Fatal(err)
		}
		announceSetup(startup, code)
	}
	process := supervisor.New(startup.VeilBinary, startup.VeilAddress)
	if startup.EntitlementPath != "" {
		if err := process.EnableCompanyIdentity(startup.EntitlementPath, filepath.Join(startup.StateDir, "veil-identity.json")); err != nil {
			log.Fatal(err)
		}
	}
	ragSettings, err := store.RAGSettings(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	// The Qdrant key is written by the installer into the Console state
	// directory with 0600 permissions. It never enters console.db, and it
	// reaches Veil only through the child environment.
	corpus, err := rag.NewCorpus(
		store,
		filepath.Join(startup.StateDir, "documents"),
		pdfExtractorPath(startup.VeilBinary),
		ragSettings,
		readQdrantAPIKey(startup.StateDir),
	)
	if err != nil {
		log.Fatal(err)
	}
	process.SetRAG(ragSettings, readQdrantAPIKey(startup.StateDir))
	console, err := web.New(startup, store, secrets, process, corpus)
	if err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{
		Addr: console.Address(), Handler: console.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	shutdownSignal, stopSignal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	go console.StartLastKnownGood(shutdownSignal)
	go corpus.Run(shutdownSignal)
	go func() {
		<-shutdownSignal.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = console.Shutdown(ctx)
		_ = httpServer.Shutdown(ctx)
	}()
	log.Printf("Veil Console listening on http://%s", console.Address())
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// pdfExtractorPath finds `umbratic-pdf` next to the Veil binary, which is where
// the release zip installs it. An absent extractor is not fatal: every other
// document type still indexes, and a PDF upload fails with a clear reason.
func pdfExtractorPath(veilBinary string) string {
	candidate := filepath.Join(filepath.Dir(veilBinary), "umbratic-pdf")
	info, err := os.Lstat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return candidate
}

func readQdrantAPIKey(stateDir string) string {
	payload, err := os.ReadFile(filepath.Join(stateDir, "qdrant-api-key"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(payload))
}

func announceSetup(startup config.Startup, code string) {
	if os.Getenv("INVOCATION_ID") == "" {
		fmt.Printf("Setup URL: http://%s/setup\nSetup code: %s\n", net.JoinHostPort(startup.Listen, fmt.Sprint(startup.Port)), code)
		return
	}
	runtimeDir := "/run/veil-console"
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		log.Fatal("create setup-code runtime directory: ", err)
	}
	path := filepath.Join(runtimeDir, "setup-code")
	if err := os.WriteFile(path, []byte(code+"\n"), 0o600); err != nil {
		log.Fatal("write setup-code file: ", err)
	}
	time.AfterFunc(15*time.Minute, func() { _ = os.Remove(path) })
	log.Printf("read the one-time setup code from %s", path)
}
