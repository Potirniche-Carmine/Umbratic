package deployment

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMacInstallationUsesApplicationSupport(t *testing.T) {
	if got := filepath.ToSlash(programDirectory("darwin")); got != "/Library/Application Support/Umbratic/Veil Console/Program" {
		t.Fatal(got)
	}
	if got := filepath.ToSlash(stateDirectory("darwin")); got != "/Library/Application Support/Umbratic/Veil Console/State" {
		t.Fatal(got)
	}
	if programDirectory("linux") != "/opt/umbratic/veil-console" || stateDirectory("linux") != "/var/lib/veil-console" {
		t.Fatal("Linux installation paths changed")
	}
}

func TestExistingProgramRecognizesMigrationAndRefusesAmbiguity(t *testing.T) {
	root := t.TempDir()
	current, former := filepath.Join(root, "new"), filepath.Join(root, "old")
	if got, err := findExistingProgram(current, former); err != nil || got != "" {
		t.Fatalf("fresh install: %q %v", got, err)
	}
	if err := os.Mkdir(former, 0700); err != nil {
		t.Fatal(err)
	}
	if got, err := findExistingProgram(current, former); err != nil || got != former {
		t.Fatalf("migration: %q %v", got, err)
	}
	if err := os.Mkdir(current, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := findExistingProgram(current, former); err == nil {
		t.Fatal("ambiguous installation was accepted")
	}
	if err := os.Remove(former); err != nil {
		t.Fatal(err)
	}
	if got, err := findExistingProgram(current, former); err != nil || got != current {
		t.Fatalf("redeploy: %q %v", got, err)
	}
}

func TestArchiveFormerLayoutPreservesHistoryAndNeverOverwrites(t *testing.T) {
	root := t.TempDir()
	former, backup := filepath.Join(root, "opt", "umbratic"), filepath.Join(root, "Application Support", "Backups", "today")
	for _, directory := range []string{former, backup} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	name := "veil-console.backup-earlier"
	if err := os.WriteFile(filepath.Join(former, name), []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(root, "Application Support", "Program")
	lock, err := acquireInstallationLock(program)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if other, err := acquireInstallationLock(program); err == nil {
		other.Close()
		t.Fatal("contender acquired the installation lock before archival")
	} else if !strings.Contains(err.Error(), "another deployment is running") {
		t.Fatal(err)
	}
	if err := archiveFormerLayout(former, backup); err != nil {
		t.Fatal(err)
	}
	if other, err := acquireInstallationLock(program); err == nil {
		other.Close()
		t.Fatal("archiving the old layout lost the current installation lock")
	} else if !strings.Contains(err.Error(), "another deployment is running") {
		t.Fatal(err)
	}
	if _, err := os.Stat(former); !os.IsNotExist(err) {
		t.Fatal("former directory remains")
	}
	archived := filepath.Join(backup, "previous-layout", name)
	if data, err := os.ReadFile(archived); err != nil || string(data) != "preserved" {
		t.Fatalf("historical backup changed: %q %v", data, err)
	}
	if err := os.Mkdir(former, 0700); err != nil {
		t.Fatal(err)
	}
	if err := archiveFormerLayout(former, backup); err == nil {
		t.Fatal("existing archive was overwritten")
	}
	if _, err := os.Stat(former); err != nil {
		t.Fatal("failed archive removed its source")
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := acquireInstallationLock(program)
	if err != nil {
		t.Fatalf("completed migration left the installation locked: %v", err)
	}
	next.Close()
}

func TestLaunchdPathsWithSpacesRemainSingleArguments(t *testing.T) {
	args := []string{programDirectory("darwin") + "/bin/veil-console", "--state-dir", stateDirectory("darwin"), "a&b"}
	var plist struct {
		Dict struct {
			Array struct {
				Values []string `xml:"string"`
			} `xml:"array"`
			Environment struct {
				Keys   []string `xml:"key"`
				Values []string `xml:"string"`
			} `xml:"dict"`
		} `xml:"dict"`
	}
	if err := xml.Unmarshal([]byte(launchdService("console", args)), &plist); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plist.Dict.Array.Values, args) {
		t.Fatalf("arguments changed: %q", plist.Dict.Array.Values)
	}
	environment := make(map[string]string)
	for i, key := range plist.Dict.Environment.Keys {
		environment[key] = plist.Dict.Environment.Values[i]
	}
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		if environment[key] != filepath.Join(stateDir, "tmp") {
			t.Fatalf("%s is outside the private temporary directory", key)
		}
	}
	for _, key := range []string{"XDG_CACHE_HOME", "HF_HOME", "VLLM_CACHE_ROOT", "TORCH_HOME"} {
		relative, err := filepath.Rel(stateDir, environment[key])
		if err != nil || strings.HasPrefix(relative, "..") || filepath.IsAbs(relative) {
			t.Fatalf("%s escaped Console state", key)
		}
	}
}
