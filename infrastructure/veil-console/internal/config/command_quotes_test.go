package config

import (
	"reflect"
	"testing"
)

func TestCommandFormattingPreservesLiteralQuotes(t *testing.T) {
	for _, value := range []string{
		`{"turboquant":true,"k_quant":"q8_0","v_quant":"q8_0"}`,
		`{"label":"user's cache"}`,
		`/models/user's-model`,
		`/models/folder with spaces`,
	} {
		args := []string{"serve", "model", "--additional-config", value}
		for range 3 {
			formatted := FormatCommand(args)
			parsed, err := splitCommand(formatted)
			if err != nil || !reflect.DeepEqual(args, parsed) {
				t.Fatalf("argument changed after formatting %q: %#v, %v", value, parsed, err)
			}
			args = parsed
		}
	}
}
