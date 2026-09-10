package supervisor

import (
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"umbratic-veil-console/internal/config"
)

// PrepareCommand prepares editable defaults. Registering a stopped model does
// not reserve GPU memory; allocation is checked only when starting it.
func (m *ModelSupervisor) PrepareCommand(model config.ManagedModel) (config.ManagedModel, error) {
	facts, err := model.Parse()
	if err != nil {
		return model, err
	}
	if config.NormalizeRole(model.Role) == config.RoleChat && InspectModel(facts.ModelPath).Architecture == "Qwen3_5ForConditionalGeneration" {
		facts.Args = append(facts.Args, "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_xml", "--reasoning-parser", "qwen3")
		model.Command = config.FormatCommand(facts.Args)
	}
	if config.NormalizeRole(model.Role) == config.RoleChat {
		hasCacheType := false
		for _, arg := range facts.Args {
			if arg == "--kv-cache-dtype" || strings.HasPrefix(arg, "--kv-cache-dtype=") {
				hasCacheType = true
			}
		}
		if !hasCacheType {
			model.Command += "\n--kv-cache-dtype fp8"
		}
	}
	return model, nil
}

// allocation sizes a default budget from local weights plus bounded KV/runtime
// headroom. It does not reserve the same share of memory for every model.
// launchMu serializes allocation and publication of newly started processes.
func (m *ModelSupervisor) allocation(model config.ManagedModel) (config.ManagedModel, float64, error) {
	facts, err := model.Parse()
	if err != nil {
		return model, 0, err
	}
	fraction := 0.0
	explicit := false
	for i, arg := range facts.Args {
		value, ok := strings.CutPrefix(arg, "--gpu-memory-utilization=")
		if arg == "--gpu-memory-utilization" && i+1 < len(facts.Args) {
			value, ok = facts.Args[i+1], true
		}
		if ok {
			fraction, err = strconv.ParseFloat(value, 64)
			if err != nil || math.IsNaN(fraction) || fraction <= 0 || fraction > 1 {
				return model, 0, errors.New("GPU memory utilization must be greater than zero and at most one")
			}
			explicit = true
		}
	}
	total := DetectHardware().GPUBytes
	if total == 0 {
		return model, fraction, nil
	}
	var weights int64
	err = filepath.WalkDir(facts.ModelPath, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && info.Size() > 1<<20 {
			weights += info.Size()
		}
		return nil
	})
	if err != nil {
		return model, 0, errors.New("model weight files could not be inspected")
	}
	if !explicit {
		fraction = math.Max(0.08, (float64(weights)*1.15+float64(2<<30))/float64(total))
		fraction = math.Ceil(fraction*100) / 100
	}
	used := 0.0
	m.mu.Lock()
	for _, p := range m.processes {
		if p.status.PID > 0 {
			used += p.allocation
		}
	}
	m.mu.Unlock()
	// Keep headroom in automatic budgets, but honor an administrator's explicit
	// allocation up to the full device. The runtime checks actual free memory.
	limit := 0.85
	if explicit {
		limit = 1
	}
	if used+fraction > limit+1e-9 {
		return model, 0, errors.New("the combined model memory budgets exceed available GPU memory; stop a model or lower --gpu-memory-utilization in its command")
	}
	if !explicit {
		model.Command += "\n--gpu-memory-utilization " + strconv.FormatFloat(fraction, 'f', 2, 64)
	}
	return model, fraction, nil
}
