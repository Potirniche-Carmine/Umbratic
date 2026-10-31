package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"umbratic-veil-console/internal/state"
)

// A private local socket issues setup credentials only when the installer has
// finished its readiness checks. Nothing secret goes to service stdout.
func serveBootstrap(store *state.Store, directory string) (net.Listener, error) {
	path := filepath.Join(directory, "bootstrap.sock")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				command, err := bufio.NewReader(conn).ReadString('\n')
				if err != nil || command != "issue\n" {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				claimed, err := store.IsSetup(ctx)
				if err != nil {
					return
				}
				if claimed {
					fmt.Fprintln(conn, "claimed")
					return
				}
				code, err := store.NewSetup(ctx, time.Now())
				if errors.Is(err, state.ErrSetupComplete) {
					fmt.Fprintln(conn, "claimed")
					return
				}
				if err == nil {
					fmt.Fprintln(conn, code)
				}
			}()
		}
	}()
	return listener, nil
}

func requestSetupCode(directory string) error {
	conn, err := net.DialTimeout("unix", filepath.Join(directory, "bootstrap.sock"), 5*time.Second)
	if err != nil {
		return errors.New("Console bootstrap is not ready")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := fmt.Fprintln(conn, "issue"); err != nil {
		return err
	}
	code, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return errors.New("Console did not issue a setup code")
	}
	fmt.Print(code)
	return nil
}
