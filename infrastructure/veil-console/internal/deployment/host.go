package deployment

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"umbratic-veil-console/internal/config"
)

const installDir = "/opt/umbratic/veil-console"

var stateDir = func() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/Umbratic/Veil Console/State"
	}
	return "/var/lib/veil-console"
}()

const serviceUser = "_umbratic"

func run(binary string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, binary, args...)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", filepath.Base(binary), err)
	}
	return nil
}

func output(binary string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, binary, args...).Output()
	return strings.TrimSpace(string(data)), err
}

func Preflight(p Package) error {
	if err := checkCaddyConfiguration(filepath.Join(p.Directory, "bin/caddy"), config.DefaultConnection(), p.Config.VeilPort); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		version, err := output("/usr/bin/sw_vers", "-productVersion")
		if err != nil {
			return err
		}
		major, _ := strconv.Atoi(strings.Split(version, ".")[0])
		if major < 15 {
			return errors.New("Metal requires macOS 15 or later")
		}
	} else {
		release, err := os.ReadFile("/etc/os-release")
		if err != nil {
			return err
		}
		if !strings.Contains(string(release), "ID=ubuntu") || !strings.Contains(string(release), `VERSION_ID="24.04"`) {
			return errors.New("this release requires Ubuntu 24.04 LTS")
		}
		if p.Config.Profile == "cuda" {
			if err := run("nvidia-smi"); err != nil {
				return errors.New("install the release-supported NVIDIA driver, reboot, and rerun deploy.sh")
			}
		} else {
			devicePath := "/dev/dri"
			if p.Config.Profile == "rocm-wsl" {
				devicePath = "/dev/dxg"
			}
			if _, err := os.Stat(devicePath); err != nil {
				return errors.New("the AMD GPU driver is unavailable; install the supported host driver and rerun deploy.sh")
			}
			if p.Config.Profile != "rocm-wsl" {
				if _, err := os.Stat("/dev/kfd"); err != nil {
					return errors.New("the AMD compute device /dev/kfd is missing; install the supported driver and rerun deploy.sh")
				}
			}
		}
	}
	// A first install must not take over another application's ports. Redeploy
	// stops the owned services before checking the ports again.
	if _, err := os.Stat(installDir); os.IsNotExist(err) {
		return checkPorts(p.Config)
	}
	return nil
}

func checkPorts(c Config) error {
	for _, port := range []int{c.ConsolePort, c.VeilPort, 6333, 6334} {
		l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return fmt.Errorf("port %d is in use; stop its owner or build a package with different ports", port)
		}
		l.Close()
	}
	return nil
}

func ensureUser() error {
	if _, err := output("id", "-u", serviceUser); err == nil {
		return nil
	}
	if runtime.GOOS == "linux" {
		return run("useradd", "--system", "--home", stateDir, "--shell", "/usr/sbin/nologin", serviceUser)
	}
	uid := 400
	for ; uid < 500; uid++ {
		if _, err := output("id", "-nu", strconv.Itoa(uid)); err != nil {
			break
		}
	}
	if uid == 500 {
		return errors.New("no free system service UID")
	}
	path := "/Users/" + serviceUser
	for _, args := range [][]string{{"-create", path}, {"-create", path, "UniqueID", strconv.Itoa(uid)}, {"-create", path, "PrimaryGroupID", "1"}, {"-create", path, "UserShell", "/usr/bin/false"}, {"-create", path, "NFSHomeDirectory", stateDir}, {"-create", path, "IsHidden", "1"}, {"-create", path, "Password", "*"}} {
		if err := run("/usr/bin/dscl", append([]string{"."}, args...)...); err != nil {
			return err
		}
	}
	return nil
}

func installRuntime(p Package) error {
	if p.Config.Profile == "metal" {
		pythonDir := filepath.Join(installDir, "python")
		if err := os.MkdirAll(pythonDir, 0755); err != nil {
			return err
		}
		if err := run("/usr/bin/tar", "-xzf", filepath.Join(installDir, "runtime/python.tar.gz"), "-C", pythonDir, "--strip-components=1"); err != nil {
			return err
		}
		uv := filepath.Join(installDir, "bin/uv")
		python := filepath.Join(pythonDir, "bin/python3")
		venv := filepath.Join(installDir, "venv")
		if err := run(uv, "venv", "--offline", "--python", python, venv); err != nil {
			return err
		}
		return run(uv, "pip", "sync", "--python", filepath.Join(venv, "bin/python"), "--no-index", "--only-binary=:all:", "--require-hashes", "--find-links", filepath.Join(installDir, "runtime/wheels"), filepath.Join(installDir, "runtime/requirements.txt"))
	}
	packages, err := filepath.Glob(filepath.Join(installDir, "runtime/debs/*.deb"))
	if err != nil {
		return err
	}
	if len(packages) == 0 {
		return errors.New("release is missing the offline Docker/GPU dependency packages")
	}
	if err := run("apt-get", append([]string{"install", "--yes", "--no-download"}, packages...)...); err != nil {
		return err
	}
	if err := run("systemctl", "enable", "--now", "docker"); err != nil {
		return err
	}
	if err := run("usermod", "-aG", "docker", serviceUser); err != nil {
		return err
	}
	if p.Config.Profile == "cuda" {
		if err := run("nvidia-ctk", "runtime", "configure", "--runtime=docker"); err != nil {
			return err
		}
		if err := run("systemctl", "restart", "docker"); err != nil {
			return err
		}
	}
	if err := run("docker", "load", "--input", filepath.Join(installDir, "runtime/image.tar")); err != nil {
		return err
	}
	return run("docker", "image", "inspect", p.Manifest.Image)
}
