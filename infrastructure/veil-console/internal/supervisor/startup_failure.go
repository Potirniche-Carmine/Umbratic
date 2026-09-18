package supervisor

import "strings"

// A deterministic cache capacity error cannot recover by launching the same
// command again. Keep the original log and wait for an administrator's edit.
func startupFailure(log string) string {
	if strings.Contains(log, "KV cache is needed") && strings.Contains(log, "available KV cache memory") {
		return "Context exceeds available memory. Reduce --max-model-len (try 16384), then start again."
	}
	return ""
}
