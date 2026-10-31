package json

import (
	"strings"
	"testing"
)

func TestJSONNestingBoundAppliesBeforeDecoding(t *testing.T) {
	for _, depth := range []int{10, maxNestingDepth, maxNestingDepth + 1} {
		data := []byte(strings.Repeat("[", depth) + "0" + strings.Repeat("]", depth))
		var result interface{}
		err := Unmarshal(data, &result)
		if depth <= maxNestingDepth && err != nil {
			t.Fatal("valid bounded JSON rejected:", err)
		}
		if depth > maxNestingDepth && err == nil {
			t.Fatal("JSON beyond the nesting limit was accepted")
		}
	}
}
