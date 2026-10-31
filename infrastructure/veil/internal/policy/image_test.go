package policy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestImageInputBoundsAndFutureVocabulary(t *testing.T) {
	for _, body := range []string{
		`{"prompt":"a red sphere"}`,
		`{"prompt":"a red sphere","width":256,"height":1024,"future_harness":{"style":"anything"}}`,
	} {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &raw); err != nil {
			t.Fatal(err)
		}
		input, err := DecodeImageInput(raw)
		if err != nil || input.Prompt != "a red sphere" {
			t.Fatalf("future harness rejected: %v", err)
		}
	}
	for _, body := range []string{
		`{}`, `{"prompt":" "}`, `{"prompt":null}`, `{"prompt":"x","width":0}`,
		`{"prompt":"x","width":257}`, `{"prompt":"x","height":1025}`, `{"prompt":"x","width":"512"}`,
		`{"prompt":"x","system":"override"}`, `{"prompt":"x","binary":"/tmp/evil"}`,
		`{"prompt":"x","model":"other"}`, `{"prompt":"` + strings.Repeat("x", 8001) + `"}`,
	} {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &raw); err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeImageInput(raw); err == nil {
			t.Fatalf("accepted invalid input: %.100s", body)
		}
	}
}
