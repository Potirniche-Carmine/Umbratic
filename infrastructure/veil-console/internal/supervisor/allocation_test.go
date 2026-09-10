package supervisor

import (
	"strings"
	"testing"

	"umbratic-veil-console/internal/config"
)

func allocationHardware(t *testing.T) {
	t.Helper()
	previous := DetectHardware
	DetectHardware = func() Hardware { return Hardware{GPUBytes: 32 << 30} }
	t.Cleanup(func() { DetectHardware = previous })
}

func TestExplicitMemoryAllocation(t *testing.T) {
	allocationHardware(t)
	dir := t.TempDir()
	for _, tc := range []struct {
		name, budget string
		used         float64
		running      bool
		wantError    bool
	}{
		{"ninety percent alone", "0.90", 0, false, false},
		{"full device alone", "1", 0, false, false},
		{"fits alongside another model", "0.90", .1, true, false},
		{"combined budgets overflow", "0.90", .2, true, true},
		{"stopped model releases budget", "0.90", .2, false, false},
		{"above full device", "1.01", 0, false, true},
		{"not a number", "NaN", 0, false, true},
		{"zero", "0", 0, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pid := 0
			if tc.running {
				pid = 123
			}
			m := &ModelSupervisor{processes: map[string]*managedProcess{
				"other": {allocation: tc.used, status: ModelStatus{PID: pid}},
			}}
			model := config.ManagedModel{ID: "model", Command: config.DefaultCommand(dir, "model", 8001)}
			model.Command = strings.Replace(model.Command, "16384", "64000", 1) + "\n--gpu-memory-utilization " + tc.budget
			got, _, err := m.allocation(model)
			if (err != nil) != tc.wantError {
				t.Fatalf("allocation error = %v, want error %v", err, tc.wantError)
			}
			if err == nil && got.Command != model.Command {
				t.Fatal("explicit context and memory budget must be preserved")
			}
		})
	}
}

func TestPrepareCommandCacheDefaults(t *testing.T) {
	allocationHardware(t)
	dir := t.TempDir()
	for _, tc := range []struct {
		role, flag, want string
	}{
		{config.RoleChat, "", "--kv-cache-dtype fp8"},
		{config.RoleChat, "--kv-cache-dtype auto", "--kv-cache-dtype auto"},
		{config.RoleChat, "--kv-cache-dtype=auto", "--kv-cache-dtype=auto"},
		{config.RoleSpeech, "", ""},
		{config.RoleEmbedding, "", ""},
	} {
		t.Run(tc.role+tc.flag, func(t *testing.T) {
			model := config.ManagedModel{ID: "model", Role: tc.role, Command: config.DefaultCommand(dir, "model", 8001)}
			model.Command += "\n" + tc.flag
			got, err := (&ModelSupervisor{}).PrepareCommand(model)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "" {
				if strings.Contains(got.Command, "--kv-cache-dtype") {
					t.Fatal("non-chat models must retain runtime cache defaults")
				}
			} else if !strings.Contains(got.Command, tc.want) || strings.Count(got.Command, "--kv-cache-dtype") != 1 {
				t.Fatalf("cache default must preserve explicit choices: %s", got.Command)
			}
		})
	}
}

func TestPrepareCommandDoesNotAllocateMemory(t *testing.T) {
	previous := DetectHardware
	DetectHardware = func() Hardware {
		t.Fatal("saving a stopped model must not inspect or reserve GPU capacity")
		return Hardware{}
	}
	t.Cleanup(func() { DetectHardware = previous })
	m := &ModelSupervisor{processes: map[string]*managedProcess{
		"serving": {allocation: 1, status: ModelStatus{PID: 123}},
	}}
	model := config.ManagedModel{ID: "next", Command: config.DefaultCommand(t.TempDir(), "next", 8002)}
	prepared, err := m.PrepareCommand(model)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prepared.Command, "--gpu-memory-utilization") {
		t.Fatal("registration must not persist an allocation based on current hardware or running models")
	}
}
