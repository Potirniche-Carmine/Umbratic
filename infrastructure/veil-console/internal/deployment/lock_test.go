package deployment

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeploymentLockReleasesAfterClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deploy-lock")
	lock, err := acquireDeploymentLock(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lock.Close() })
	if other, err := acquireDeploymentLock(path); err == nil {
		other.Close()
		t.Fatal("concurrent deployment acquired the lock")
	} else if !strings.Contains(err.Error(), "another deployment is running") {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lock file must remain to avoid racing on a different inode: %v", err)
	}
	next, err := acquireDeploymentLock(path)
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
}

func TestDeploymentLockReleasesAfterProcessExit(t *testing.T) {
	if path := os.Getenv("UMBRATIC_DEPLOY_LOCK_TEST"); path != "" {
		lock, err := acquireDeploymentLock(path)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		os.Stdout.WriteString("locked\n")
		time.Sleep(time.Minute)
		return
	}
	path := filepath.Join(t.TempDir(), "deploy-lock")
	cmd := exec.Command(os.Args[0], "-test.run=^TestDeploymentLockReleasesAfterProcessExit$")
	cmd.Env = append(os.Environ(), "UMBRATIC_DEPLOY_LOCK_TEST="+path)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- line
	}()
	select {
	case line := <-ready:
		if line != "locked\n" {
			t.Fatalf("lock process did not start: %q", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("lock process timed out")
	}
	if other, err := acquireDeploymentLock(path); err == nil {
		other.Close()
		t.Fatal("concurrent process acquired the deployment lock")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("lock process should have been killed")
	}
	next, err := acquireDeploymentLock(path)
	if err != nil {
		t.Fatalf("interrupted deployment left its lock held: %v", err)
	}
	next.Close()
}

func TestDeploymentLockRemainsExclusiveAcrossDirectoryRename(t *testing.T) {
	root := t.TempDir()
	before, after := filepath.Join(root, "before"), filepath.Join(root, "after")
	if err := os.Mkdir(before, 0700); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireDeploymentLock(filepath.Join(before, "deploy-lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := os.Rename(before, after); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(after, "deploy-lock")
	if other, err := acquireDeploymentLock(moved); err == nil {
		other.Close()
		t.Fatal("renaming the directory released the deployment lock")
	} else if !strings.Contains(err.Error(), "another deployment is running") {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := acquireDeploymentLock(moved)
	if err != nil {
		t.Fatalf("closing the moved lock did not release it: %v", err)
	}
	next.Close()
}
