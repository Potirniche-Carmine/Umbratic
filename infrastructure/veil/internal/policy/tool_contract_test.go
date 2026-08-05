package policy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"umbratic-veil/internal/prompts"
)

// The runner generates its tool contract from one catalog; this file is that
// exact output. Validating it here is what makes the two independent validators
// agree — a field the runner adds and Veil rejects fails at build time instead
// of as a 400 on the first real request.
const toolContractFixture = "../../../../apps/desktop/tests/fixtures/tool-contract.golden.json"

func TestVeilAcceptsTheGeneratedRunnerToolContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(toolContractFixture))
	if err != nil {
		t.Fatalf("read tool contract fixture: %v", err)
	}
	var tools []any
	if err := json.Unmarshal(raw, &tools); err != nil {
		t.Fatalf("tool contract fixture is not JSON: %v", err)
	}
	if len(tools) == 0 {
		t.Fatal("tool contract fixture is empty")
	}
	if err := validateToolContract(tools); err != nil {
		t.Fatalf("Veil rejected the runner's generated tool contract: %v", err)
	}
}

func TestChatRouteAcceptsTheGeneratedRunnerToolContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(toolContractFixture))
	if err != nil {
		t.Fatalf("read tool contract fixture: %v", err)
	}
	body := `{"messages":[{"role":"user","content":"hello"}],"stream":true,"tools":` + string(raw) + `}`
	if _, err := DecodeChatInput(strings.NewReader(body), prompts.EngineeringChat); err != nil {
		t.Fatalf("chat route rejected the runner's generated tools: %v", err)
	}
}
