// Package deployment validates and installs a customer release without a source toolchain.
package deployment

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"umbratic-veil-console/internal/entitlement"
)

type Config struct {
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	ConsolePort int    `json:"console_port"`
	VeilPort    int    `json:"veil_port"`
	Profile     string `json:"profile"`
}

// Dependencies are produced and reviewed on the release machine. The package
// carries the exact artifacts, including the complete Python wheel closure or
// Linux packages and container image; the customer host never resolves latest.
type Manifest struct {
	Version      string            `json:"version"`
	Files        map[string]string `json:"files"`
	Dependencies map[string]string `json:"dependencies"`
	Image        string            `json:"image,omitempty"`
}

type Package struct {
	Directory string
	Config    Config
	Manifest  Manifest
	License   entitlement.Payload
}

var imageDigest = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64}$`)

func (c Config) Validate() error {
	if c.OS != "linux" && c.OS != "darwin" {
		return errors.New("supported operating systems are linux and darwin")
	}
	if c.Arch != "amd64" && c.Arch != "arm64" || c.OS == "darwin" && c.Arch != "arm64" {
		return errors.New("unsupported CPU architecture")
	}
	ports := map[int]bool{6333: true, 6334: true}
	for _, port := range []int{c.ConsolePort, c.VeilPort} {
		if port < 1024 || port > 65535 || ports[port] {
			return errors.New("service ports must be distinct, between 1024 and 65535, and not Qdrant ports")
		}
		ports[port] = true
	}
	switch c.Profile {
	case "metal":
		if c.OS != "darwin" {
			return errors.New("Metal requires Apple Silicon")
		}
	case "cuda":
		if c.OS != "linux" {
			return errors.New("CUDA requires Linux")
		}
	case "rocm", "rocm-integrated", "rocm-wsl":
		if c.OS != "linux" || c.Arch != "amd64" {
			return errors.New("ROCm requires Linux amd64")
		}
	default:
		return errors.New("select a fixed runtime profile: metal, cuda, rocm, rocm-integrated, rocm-wsl")
	}
	return nil
}

func readJSON(path string, value any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 8<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func Load(directory string) (Package, error) {
	p := Package{Directory: directory}
	if err := readJSON(filepath.Join(directory, "manifest.json"), &p.Manifest); err != nil {
		return p, err
	}
	if err := VerifyFiles(directory, p.Manifest.Files); err != nil {
		return p, err
	}
	if err := readJSON(filepath.Join(directory, "deployment.json"), &p.Config); err != nil {
		return p, err
	}
	if err := p.Config.Validate(); err != nil {
		return p, err
	}
	if p.Config.OS != runtime.GOOS || p.Config.Arch != runtime.GOARCH {
		return p, errors.New("this ZIP does not match the host OS and CPU architecture")
	}
	license, err := entitlement.Load(filepath.Join(directory, "entitlement.json"))
	if err != nil {
		return p, err
	}
	p.License = license
	required := []string{"deploy.sh", "deployment.json", "entitlement.json", "README.md", "bin/deploy", "bin/veil", "bin/veil-console", "bin/umbratic-pdf", "bin/caddy", "bin/qdrant", "bin/ffmpeg"}
	if p.Config.Profile == "metal" {
		required = append(required, "Models.app/Contents/Info.plist", "Models.app/Contents/MacOS/models-folder", "bin/uv", "runtime/python.tar.gz", "runtime/requirements.txt")
		for _, name := range []string{"python", "uv", "vllm", "vllm-metal", "caddy", "qdrant", "ffmpeg"} {
			if p.Manifest.Dependencies[name] == "" {
				return p, fmt.Errorf("missing pinned dependency: %s", name)
			}
		}
	} else {
		required = append(required, "runtime/image.tar")
		if !imageDigest.MatchString(p.Manifest.Image) {
			return p, errors.New("runtime image must be pinned by SHA256 digest")
		}
	}
	for _, name := range required {
		if _, ok := p.Manifest.Files[name]; !ok {
			return p, fmt.Errorf("required installation input missing: %s", name)
		}
	}
	return p, nil
}

// Every file must be covered; a checked binary with an unchecked installer or
// service template is not a checked installation. Symlinks are refused.
func VerifyFiles(directory string, files map[string]string) error {
	seen := map[string]bool{}
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		name, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		if name == "manifest.json" || name == "SHA256SUMS" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("non-regular installation input: %s", name)
		}
		expected, ok := files[name]
		if !ok || len(expected) != 64 {
			return fmt.Errorf("unchecked installation input: %s", name)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil {
			return err
		}
		if hex.EncodeToString(hash.Sum(nil)) != expected {
			return fmt.Errorf("checksum mismatch: %s", name)
		}
		seen[name] = true
		return nil
	})
	if err != nil {
		return err
	}
	for name := range files {
		if !seen[name] {
			return fmt.Errorf("missing installation input: %s", name)
		}
	}
	return nil
}
