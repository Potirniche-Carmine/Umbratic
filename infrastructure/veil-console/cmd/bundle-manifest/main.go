package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"umbratic-veil-console/internal/deployment"
)

func main() {
	if err := build(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func build() error {
	directory := flag.String("directory", "", "bundle directory")
	releaseVersion := flag.String("version", "", "release version")
	cfg := deployment.Config{}
	flag.StringVar(&cfg.OS, "os", "linux", "target OS")
	flag.StringVar(&cfg.Arch, "arch", "amd64", "target CPU")
	flag.StringVar(&cfg.Profile, "profile", "cuda", "runtime profile")
	flag.IntVar(&cfg.ConsolePort, "console-port", 8177, "Console port")
	flag.IntVar(&cfg.VeilPort, "veil-port", 8080, "Veil port")
	flag.Parse()
	if err := cfg.Validate(); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(*directory, "dependencies.json"))
	if err != nil {
		return err
	}
	var manifest deployment.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	if err := deployment.VerifyFiles(filepath.Join(*directory, "dependencies"), manifest.Files); err != nil {
		return fmt.Errorf("dependency kit: %w", err)
	}
	// The reviewed kit contains bin/ and runtime/; no installer code from it runs.
	for _, dir := range []string{"bin", "runtime"} {
		source := filepath.Join(*directory, "dependencies", dir)
		err := filepath.WalkDir(source, func(path string, e fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, _ := filepath.Rel(source, path)
			dest := filepath.Join(*directory, dir, relative)
			if e.IsDir() {
				return os.MkdirAll(dest, 0755)
			}
			if _, err := os.Lstat(dest); err == nil {
				return fmt.Errorf("dependency would overwrite %s", dest)
			}
			input, err := os.Open(path)
			if err != nil {
				return err
			}
			defer input.Close()
			info, err := input.Stat()
			if err != nil {
				return err
			}
			output, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(output, input)
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			return closeErr
		})
		if err != nil {
			return err
		}
	}
	if err := os.RemoveAll(filepath.Join(*directory, "dependencies")); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(*directory, "dependencies.json")); err != nil {
		return err
	}
	configData, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(filepath.Join(*directory, "deployment.json"), append(configData, '\n'), 0644); err != nil {
		return err
	}
	manifest.Version = *releaseVersion
	manifest.Files = map[string]string{}
	var sums strings.Builder
	err = filepath.WalkDir(*directory, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			return nil
		}
		name, _ := filepath.Rel(*directory, path)
		name = filepath.ToSlash(name)
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(hash, input)
		input.Close()
		if err != nil {
			return err
		}
		sum := hex.EncodeToString(hash.Sum(nil))
		manifest.Files[name] = sum
		fmt.Fprintf(&sums, "%s  %s\n", sum, name)
		return nil
	})
	if err != nil {
		return err
	}
	data, _ = json.MarshalIndent(manifest, "", "  ")
	data = append(data, '\n')
	if err := os.WriteFile(filepath.Join(*directory, "manifest.json"), data, 0644); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	fmt.Fprintf(&sums, "%x  manifest.json\n", sum)
	return os.WriteFile(filepath.Join(*directory, "SHA256SUMS"), []byte(sums.String()), 0644)
}
