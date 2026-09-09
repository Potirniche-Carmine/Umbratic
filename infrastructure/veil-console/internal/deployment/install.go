package deployment

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"umbratic-veil-console/internal/entitlement"
)

func Install(p Package, clean bool) (result error) {
	if os.Geteuid() != 0 {
		return errors.New("run sudo ./deploy.sh")
	}
	if err := diskSpace(p.Directory); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(installDir), 0755); err != nil {
		return err
	}
	lock := installDir + ".deploy-lock"
	if err := os.Mkdir(lock, 0700); err != nil {
		return errors.New("another deployment is running (or left a lock after interruption); inspect " + lock)
	}
	defer os.Remove(lock)
	if clean {
		if err := removeInstallation(); err != nil {
			return err
		}
	}
	backup := installDir + ".backup-" + time.Now().UTC().Format("20060102T150405Z")
	if err := os.Mkdir(backup, 0700); err != nil {
		return err
	}
	previous := false
	if _, err := os.Stat(installDir); err == nil {
		previous = true
	}
	if previous {
		old, err := entitlement.Load(filepath.Join(installDir, "entitlement.json"))
		if err != nil {
			return fmt.Errorf("validate existing installation: %w", err)
		}
		if old.OrgUID != p.License.OrgUID {
			return errors.New("the new ZIP belongs to a different organization")
		}
	}
	snapshotComplete := false
	defer func() {
		if result != nil && !snapshotComplete && previous {
			if err := startServices(); err != nil {
				result = fmt.Errorf("%w; previous service restart failed: %v", result, err)
			}
		}
	}()
	if err := stopServices(); err != nil {
		return err
	}
	// Snapshot stopped SQLite, identity, documents, and TLS together. No open
	// database copy and no regenerated secrets on a redeploy.
	if previous {
		if err := run("cp", "-pR", installDir, filepath.Join(backup, "program")); err != nil {
			return err
		}
	}
	if _, err := os.Stat(stateDir); err == nil {
		if err := run("cp", "-pR", stateDir, filepath.Join(backup, "state")); err != nil {
			return err
		}
	}
	for _, name := range services {
		if data, err := os.ReadFile(servicePath(name)); err == nil {
			if err := os.WriteFile(filepath.Join(backup, name), data, 0600); err != nil {
				return err
			}
		}
	}
	snapshotComplete = true
	defer func() {
		if result == nil {
			return
		}
		if err := stopServices(); err != nil {
			result = fmt.Errorf("%w; rollback stop failed: %v; backup: %s", result, err, backup)
			return
		}
		if err := os.RemoveAll(installDir); err != nil {
			result = fmt.Errorf("%w; rollback failed: %v", result, err)
			return
		}
		if previous {
			if err := run("cp", "-pR", filepath.Join(backup, "program"), installDir); err != nil {
				result = fmt.Errorf("%w; rollback failed: %v", result, err)
				return
			}
		}
		if _, err := os.Stat(filepath.Join(backup, "state")); err == nil {
			if err := os.RemoveAll(stateDir); err != nil {
				result = fmt.Errorf("%w; state rollback failed: %v", result, err)
				return
			}
			if err := run("cp", "-pR", filepath.Join(backup, "state"), stateDir); err != nil {
				result = fmt.Errorf("%w; state rollback failed: %v", result, err)
				return
			}
		}
		for _, name := range services {
			if data, err := os.ReadFile(filepath.Join(backup, name)); err == nil {
				_ = os.WriteFile(servicePath(name), data, 0644)
			} else {
				_ = os.Remove(servicePath(name))
			}
		}
		if previous {
			if err := startServices(); err != nil {
				result = fmt.Errorf("%w; previous service restart failed: %v", result, err)
			}
		}
	}()
	if err := checkPorts(p.Config); err != nil {
		return err
	}
	if err := ensureUser(); err != nil {
		return err
	}
	if err := os.RemoveAll(installDir); err != nil {
		return err
	}
	if err := run("cp", "-R", p.Directory, installDir); err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		return err
	}
	if err := installRuntime(p); err != nil {
		return err
	}
	if err := makeProgramReadable(); err != nil {
		return err
	}
	keyPath := filepath.Join(stateDir, "qdrant-api-key")
	key, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) {
		var bytes [32]byte
		if _, err = rand.Read(bytes[:]); err != nil {
			return err
		}
		key = []byte(hex.EncodeToString(bytes[:]))
		err = os.WriteFile(keyPath, key, 0600)
	}
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(key))) != 64 {
		return errors.New("stored Qdrant credential is invalid")
	}
	qdrant := fmt.Sprintf("storage:\n  storage_path: %s/qdrant\nservice:\n  host: 127.0.0.1\n  http_port: 6333\n  grpc_port: 6334\n  api_key: %s\ntelemetry_disabled: true\n", stateDir, strings.TrimSpace(string(key)))
	if err := os.WriteFile(filepath.Join(stateDir, "qdrant.yaml"), []byte(qdrant), 0600); err != nil {
		return err
	}
	if err := run("chown", "-R", serviceUser, stateDir); err != nil {
		return err
	}
	if err := prepareModelsDirectory(); err != nil {
		return err
	}
	if err := writeServices(p); err != nil {
		return err
	}
	if err := startServices(); err != nil {
		return err
	}
	if err := readiness(p.Config); err != nil {
		return err
	}
	// Keep setup credentials out of service and persistent deployment logs.
	code, err := output(filepath.Join(installDir, "bin/veil-console"), "--state-dir", stateDir, "--issue-setup-code")
	if err != nil || code == "" {
		return errors.New("services started but Console could not issue setup credentials")
	}
	if err := os.Remove(lock); err != nil {
		return err
	}
	fmt.Printf("Backup: %s\n", backup)
	if runtime.GOOS == "darwin" {
		fmt.Println("Services use launchd. FileVault must be unlocked after a restart; logout and reboot validation must be performed on this host.")
	}
	fmt.Println("Configure the employee address under Connection on the Veil page. Fresh installations start on localhost with private HTTPS.")
	fmt.Printf("Veil and Console are running.\nConsole: http://127.0.0.1:%d/%s\nSeats: %d\n", p.Config.ConsolePort, map[bool]string{true: "login", false: "setup"}[code == "claimed"], p.License.MaxAuthorizedUsers)
	if code != "claimed" {
		fmt.Printf("Administrator setup code: %s\n", code)
	}
	return nil
}

func readiness(c Config) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	local := &http.Client{Timeout: 3 * time.Second}
	for _, address := range []string{fmt.Sprintf("http://127.0.0.1:%d/setup", c.ConsolePort), fmt.Sprintf("http://127.0.0.1:%d/livez", c.VeilPort), "http://127.0.0.1:6333/readyz"} {
		if err := waitHTTP(ctx, local, address); err != nil {
			return err
		}
	}

	return nil
}
func waitHTTP(ctx context.Context, client *http.Client, address string) error {
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("readiness failed for %s", address)
		case <-time.After(time.Second):
		}
	}
}
func diskSpace(directory string) error {
	// Include a full stopped-state backup and room to unpack native dependencies.
	data, err := output("du", "-sk", directory)
	if err != nil {
		return err
	}
	fields := strings.Fields(data)
	if len(fields) < 1 {
		return errors.New("cannot measure package size")
	}
	size, _ := strconv.ParseInt(fields[0], 10, 64)
	existing := int64(0)
	for _, path := range []string{stateDir, installDir} {
		if data, err := output("du", "-sk", path); err == nil {
			f := strings.Fields(data)
			if len(f) > 0 {
				n, _ := strconv.ParseInt(f[0], 10, 64)
				existing += n
			}
		}
	}
	data, err = output("df", "-Pk", "/var")
	if err != nil {
		return err
	}
	lines := strings.Split(data, "\n")
	fields = strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return errors.New("cannot measure free disk space")
	}
	free, _ := strconv.ParseInt(fields[3], 10, 64)
	if free < size*3+existing+5*1024*1024 {
		return errors.New("insufficient disk space for dependencies and a consistent backup")
	}
	return nil
}

// Program inputs contain no machine secrets. Services must be able to read
// them even when the deploying administrator uses umask 077.
func makeProgramReadable() error {
	return filepath.WalkDir(installDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		mode := os.FileMode(0644)
		if entry.IsDir() || info.Mode()&0111 != 0 {
			mode = 0755
		}
		return os.Chmod(path, mode)
	})
}
