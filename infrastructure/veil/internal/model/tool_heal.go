package model

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Rescues tool calls that reached the content stream as prose.
//
// With --jinja, llama.cpp parses the Qwen chat template and emits structured
// `tool_calls` deltas, which pass through untouched. This is for the residual
// case the fixtures show: a call the template parser did not claim, which
// arrives as `<tool_call>{…}</tool_call>` or `<function=name>…</function>` in
// the visible text. Left alone, the user reads markup and the runner sees no
// call at all — a turn that silently does nothing.
//
// Deliberately narrow. It converts only the two openers above, and only when
// the span parses; anything else stays exactly as the model wrote it. It is a
// repair for a known leak, not a second parser competing with llama.cpp's.
type toolCallHealer struct {
	// buffer holds text that has arrived but cannot yet be released: either it
	// is inside a tool span, or it is a suffix that could still grow into an
	// opener.
	buffer string
	// insideToolSpan is set between an opener and its close tag.
	insideToolSpan bool
	// functionName is the name taken from a `<function=name>` opener, empty for
	// the `<tool_call>` form whose name is inside the body.
	functionName string
	// insideThinking is set between <think> and </think>. A call rehearsed
	// inside a thinking block was not issued, and executing it would run a tool
	// the model only considered.
	insideThinking bool
	nextIndex      int
}

const (
	thinkOpen     = "<think>"
	thinkClose    = "</think>"
	toolCallOpen  = "<tool_call>"
	toolCallClose = "</tool_call>"
	functionOpen  = "<function="
	functionClose = "</function>"
)

// longestMarkerPrefix is how much trailing text must be held back in case the
// next chunk completes an opener. Sized to the longest opener minus one byte.
var healerMarkers = []string{thinkOpen, thinkClose, toolCallOpen, toolCallClose, functionOpen, functionClose}

// feed takes one content delta and returns the text that may be shown now,
// plus any tool calls that completed inside it.
func (h *toolCallHealer) feed(content string) (string, []map[string]any) {
	h.buffer += content
	return h.drain(false)
}

// flush ends the stream. A span still open is parsed if it can be — a runtime
// that stopped emitting after a complete JSON body still issued a call — and
// otherwise released as the text it always was.
func (h *toolCallHealer) flush() (string, []map[string]any) {
	return h.drain(true)
}

func (h *toolCallHealer) drain(final bool) (string, []map[string]any) {
	var visible strings.Builder
	var calls []map[string]any

	for {
		if h.insideToolSpan {
			closer := toolCallClose
			if h.functionName != "" {
				closer = functionClose
			}
			end := strings.Index(h.buffer, closer)
			if end < 0 {
				if !final {
					return visible.String(), calls
				}
				// No close tag will arrive. A well-formed body still counts.
				if call, ok := h.parseSpan(h.buffer); ok {
					calls = append(calls, call)
				} else {
					visible.WriteString(h.openerText() + h.buffer)
				}
				h.buffer = ""
				h.insideToolSpan = false
				h.functionName = ""
				return visible.String(), calls
			}
			span := h.buffer[:end]
			h.buffer = h.buffer[end+len(closer):]
			if call, ok := h.parseSpan(span); ok {
				calls = append(calls, call)
			} else {
				// Detected but unreadable. Showing it is the honest outcome:
				// swallowing it would leave the user with a silent gap.
				visible.WriteString(h.openerText() + span + closer)
			}
			h.insideToolSpan = false
			h.functionName = ""
			continue
		}

		if h.insideThinking {
			end := strings.Index(h.buffer, thinkClose)
			if end < 0 {
				visible.WriteString(h.releaseSafeText(final))
				return visible.String(), calls
			}
			visible.WriteString(h.buffer[:end+len(thinkClose)])
			h.buffer = h.buffer[end+len(thinkClose):]
			h.insideThinking = false
			continue
		}

		marker, at := h.nextMarker()
		if at < 0 {
			visible.WriteString(h.releaseSafeText(final))
			return visible.String(), calls
		}
		visible.WriteString(h.buffer[:at])
		rest := h.buffer[at+len(marker):]
		switch marker {
		case thinkOpen:
			visible.WriteString(thinkOpen)
			h.buffer = rest
			h.insideThinking = true
		case toolCallOpen:
			h.buffer = rest
			h.insideToolSpan = true
		case functionOpen:
			// `<function=name>` — the name is in the opener itself.
			nameEnd := strings.Index(rest, ">")
			if nameEnd < 0 {
				if !final {
					// Put the opener back; the name may still be arriving.
					h.buffer = h.buffer[at:]
					return visible.String(), calls
				}
				visible.WriteString(functionOpen + rest)
				h.buffer = ""
				return visible.String(), calls
			}
			h.functionName = strings.TrimSpace(rest[:nameEnd])
			h.buffer = rest[nameEnd+1:]
			h.insideToolSpan = true
		}
	}
}

// openerText reconstructs what was consumed, for the paths that give up and
// show the span as written.
func (h *toolCallHealer) openerText() string {
	if h.functionName != "" {
		return functionOpen + h.functionName + ">"
	}
	return toolCallOpen
}

// nextMarker finds the earliest opener in the buffer. Close tags are not
// openers: one arriving on its own is ordinary text.
func (h *toolCallHealer) nextMarker() (string, int) {
	best := -1
	found := ""
	for _, marker := range []string{thinkOpen, toolCallOpen, functionOpen} {
		at := strings.Index(h.buffer, marker)
		if at >= 0 && (best < 0 || at < best) {
			best = at
			found = marker
		}
	}
	return found, best
}

// releaseSafeText emits everything that cannot still grow into an opener,
// holding back only a trailing partial marker.
func (h *toolCallHealer) releaseSafeText(final bool) string {
	if final {
		text := h.buffer
		h.buffer = ""
		return text
	}
	hold := 0
	for _, marker := range healerMarkers {
		for length := len(marker) - 1; length > hold; length-- {
			if length <= len(h.buffer) && h.buffer[len(h.buffer)-length:] == marker[:length] {
				hold = length
				break
			}
		}
	}
	if hold >= len(h.buffer) {
		return ""
	}
	text := h.buffer[:len(h.buffer)-hold]
	h.buffer = h.buffer[len(h.buffer)-hold:]
	return text
}

// parseSpan reads one tool-call body in either shape the fixtures show.
func (h *toolCallHealer) parseSpan(span string) (map[string]any, bool) {
	span = strings.TrimSpace(span)
	name := h.functionName
	arguments := ""

	switch {
	case strings.HasPrefix(span, "{"):
		var decoded struct {
			Name      string `json:"name"`
			Arguments any    `json:"arguments"`
		}
		if json.Unmarshal([]byte(span), &decoded) != nil {
			return nil, false
		}
		if strings.TrimSpace(decoded.Name) != "" {
			name = strings.TrimSpace(decoded.Name)
		}
		arguments = toolArgumentsString(decoded.Arguments)
	case strings.HasPrefix(span, functionOpen):
		// A `<function=…>` nested inside a `<tool_call>` wrapper.
		nameEnd := strings.Index(span, ">")
		if nameEnd < 0 {
			return nil, false
		}
		name = strings.TrimSpace(span[len(functionOpen):nameEnd])
		body := strings.TrimSuffix(strings.TrimSpace(span[nameEnd+1:]), functionClose)
		arguments = xmlParameterArguments(body)
	default:
		if name == "" {
			return nil, false
		}
		arguments = xmlParameterArguments(span)
	}

	if name == "" || arguments == "" {
		return nil, false
	}
	call := map[string]any{
		"index": h.nextIndex,
		"id":    "heal-" + strconv.Itoa(h.nextIndex),
		"type":  "function",
		"function": map[string]any{
			"name":      name,
			"arguments": arguments,
		},
	}
	h.nextIndex++
	return call, true
}

// xmlParameterArguments turns `<parameter=key>value</parameter>` repeats into
// the JSON string the runner expects. Values stay strings: the schema is the
// runner's to apply, and guessing types here would turn a path like "007" into
// a number.
func xmlParameterArguments(body string) string {
	const open = "<parameter="
	const close = "</parameter>"
	fields := map[string]string{}
	rest := body
	for {
		at := strings.Index(rest, open)
		if at < 0 {
			break
		}
		rest = rest[at+len(open):]
		nameEnd := strings.Index(rest, ">")
		if nameEnd < 0 {
			break
		}
		key := strings.TrimSpace(rest[:nameEnd])
		rest = rest[nameEnd+1:]
		valueEnd := strings.Index(rest, close)
		if valueEnd < 0 {
			// Truncated final parameter: keep what arrived rather than dropping
			// the whole call.
			if key != "" {
				fields[key] = strings.TrimSpace(rest)
			}
			rest = ""
			break
		}
		if key != "" {
			fields[key] = strings.TrimSpace(rest[:valueEnd])
		}
		rest = rest[valueEnd+len(close):]
	}
	if len(fields) == 0 {
		return ""
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return ""
	}
	return string(encoded)
}
