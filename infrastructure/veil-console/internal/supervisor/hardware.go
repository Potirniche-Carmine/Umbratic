package supervisor

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Hardware struct {
	OS, Arch, GPU, Memory, Runtime string
	GPUBytes                       uint64
}

var DetectHardware = sync.OnceValue(detectHardware)

func detectHardware() Hardware {
	h := Hardware{OS: runtime.GOOS, Arch: runtime.GOARCH, GPU: "Not detected", Memory: "Unknown", Runtime: "Not configured"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		if b, err := exec.CommandContext(ctx, "/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
			h.GPU = strings.TrimSpace(string(b))
		}
		if b, err := exec.CommandContext(ctx, "/usr/sbin/sysctl", "-n", "hw.memsize").Output(); err == nil {
			n, _ := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
			h.Memory = strconv.FormatUint(n>>30, 10) + " GiB"
			// Metal reserves part of unified memory for the OS. Use a
			// conservative budget; endpoint readiness remains the final check.
			h.GPUBytes = n * 3 / 4
		}
	} else if runtime.GOOS == "linux" {
		if b, err := exec.CommandContext(ctx, "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader").Output(); err == nil {
			h.GPU = strings.TrimSpace(string(b))
			first := strings.Split(strings.TrimSpace(string(b)), "\n")[0]
			parts := strings.Split(first, ",")
			if len(parts) > 1 {
				if fields := strings.Fields(parts[len(parts)-1]); len(fields) > 0 {
					n, _ := strconv.ParseUint(fields[0], 10, 64)
					h.GPUBytes = n << 20
				}
			}
		}
		if b, err := os.ReadFile("/proc/meminfo"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "MemTotal:") {
					f := strings.Fields(line)
					if len(f) > 1 {
						n, _ := strconv.ParseUint(f[1], 10, 64)
						h.Memory = strconv.FormatUint(n>>20, 10) + " GiB"
					}
				}
			}
		}
		if h.GPU == "Not detected" {
			if b, err := exec.CommandContext(ctx, "lspci").Output(); err == nil {
				for _, line := range strings.Split(string(b), "\n") {
					if strings.Contains(line, "VGA") || strings.Contains(line, "Display controller") {
						h.GPU = line
						break
					}
				}
			}
		}
	}
	return h
}

// ModelMetadata describes the checkpoint without executing model code.
type ModelMetadata struct{ Architecture, Quantization, SuggestedRole string }

func InspectModel(directory string) ModelMetadata {
	var config struct {
		Architectures []string `json:"architectures"`
		ModelType     string   `json:"model_type"`
		Quantization  struct {
			Bits   int    `json:"bits"`
			Method string `json:"quant_method"`
		} `json:"quantization_config"`
	}
	result := ModelMetadata{SuggestedRole: "chat"}
	file, err := os.Open(directory + "/config.json")
	if err != nil {
		return result
	}
	defer file.Close()
	if json.NewDecoder(io.LimitReader(file, 1<<20)).Decode(&config) != nil {
		return result
	}
	result.Architecture = strings.Join(config.Architectures, ", ")
	name := strings.ToLower(result.Architecture + " " + config.ModelType + " " + directory)
	if strings.Contains(name, "embedding") {
		result.SuggestedRole = "embedding"
	} else if strings.Contains(name, "whisper") || strings.Contains(name, "asr") {
		result.SuggestedRole = "speech"
	}
	result.Quantization = config.Quantization.Method
	if config.Quantization.Bits > 0 {
		result.Quantization = strconv.Itoa(config.Quantization.Bits) + "-bit " + result.Quantization
	}
	return result
}
