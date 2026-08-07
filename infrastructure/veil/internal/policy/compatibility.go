package policy

import (
	"encoding/json"
	"sync/atomic"
)

// Veil is released independently of the harness that calls it, so a newer
// harness will send vocabulary this build has never seen. The contract in the
// root AGENTS.md is that unknown vocabulary is accepted — stripped or defaulted,
// never rejected. These counters are how an operator sees that happening:
// a rising count means a newer harness is in the field, not that anything broke.
var (
	unknownBodyFields     atomic.Uint64
	unknownHarnessBuckets atomic.Uint64
)

func noteUnknownBodyFields(count int) {
	if count > 0 {
		unknownBodyFields.Add(uint64(count))
	}
}

func noteUnknownHarnessBucket() {
	unknownHarnessBuckets.Add(1)
}

// CompatibilityCounters reports the totals for the runtime metrics endpoint.
func CompatibilityCounters() map[string]uint64 {
	return map[string]uint64{
		"unknown_body_fields":     unknownBodyFields.Load(),
		"unknown_harness_buckets": unknownHarnessBuckets.Load(),
	}
}

// stripUnknownFields counts the fields in raw that this build does not know and
// reports them. The caller decodes into its own struct, which ignores the rest.
func stripUnknownFields(raw map[string]json.RawMessage, known ...string) {
	unknown := 0
	for field := range raw {
		recognized := false
		for _, name := range known {
			if field == name {
				recognized = true
				break
			}
		}
		if !recognized {
			unknown++
		}
	}
	noteUnknownBodyFields(unknown)
}
