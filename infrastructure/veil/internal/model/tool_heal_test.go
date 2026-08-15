package model

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// visibleContent joins every content delta the client would render, which is
// the only thing these fixtures assert about text.
func visibleContent(body string) string {
	var text strings.Builder
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") || line == "data: [DONE]" {
			continue
		}
		var payload struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload) != nil {
			continue
		}
		for _, choice := range payload.Choices {
			text.WriteString(choice.Delta.Content)
		}
	}
	return text.String()
}

// sse wraps chunks in the frame shape llama-server emits, so each fixture reads
// as the stream it stands in for.
func sse(frames ...string) string {
	return strings.Join(append(frames, "data: [DONE]", ""), "\n\n")
}

func contentFrame(text string) string {
	encoded, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{"delta": map[string]any{"content": text}}},
	})
	return "data: " + string(encoded)
}

func TestLocalStreamHealsLeakedToolCalls(t *testing.T) {
	for _, test := range []struct {
		name string
		// frames are content deltas, split exactly where the fixture splits.
		frames []string
		// wantCalls are name/arguments pairs the runner must end up with.
		wantCalls []string
		// wantVisible is the text the user must be shown, joined.
		wantVisible string
	}{
		{
			name:        "well-formed JSON call between prose",
			frames:      []string{"Reading it. ", `<tool_call>{"name":"read",`, `"arguments":{"path":"README.md"}}</tool_call>`, " Done."},
			wantCalls:   []string{`"name":"read"`, `"{\"path\":\"README.md\"}"`},
			wantVisible: "Reading it.  Done.",
		},
		{
			name:        "call split across chunks mid-marker",
			frames:      []string{"ok<tool", "_call>", `{"name":"grep","arguments":{"pattern":"main"}}`, "</tool_call>"},
			wantCalls:   []string{`"name":"grep"`, `"{\"pattern\":\"main\"}"`},
			wantVisible: "ok",
		},
		{
			name:        "truncated close tag still yields the call",
			frames:      []string{`<tool_call>{"name":"read","arguments":{"path":"a.txt"}}`},
			wantCalls:   []string{`"name":"read"`, `"{\"path\":\"a.txt\"}"`},
			wantVisible: "",
		},
		{
			name:        "XML parameter body",
			frames:      []string{`<function=read><parameter=path>README.md</parameter></function>`},
			wantCalls:   []string{`"name":"read"`, `"{\"path\":\"README.md\"}"`},
			wantVisible: "",
		},
		{
			name:        "XML body with a missing close tag",
			frames:      []string{`<function=grep><parameter=pattern>main`},
			wantCalls:   []string{`"name":"grep"`, `"{\"pattern\":\"main\"}"`},
			wantVisible: "",
		},
		{
			name:        "two calls in one stream keep separate indexes",
			frames:      []string{`<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>`, `<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>`},
			wantCalls:   []string{`"index":0`, `"index":1`},
			wantVisible: "",
		},
		{
			name: "a call rehearsed inside a thinking block is not executed",
			frames: []string{
				`<think>I could call <tool_call>{"name":"rm","arguments":{"path":"/"}}</tool_call> here.</think>`,
				"I will not.",
			},
			wantCalls:   nil,
			wantVisible: `<think>I could call <tool_call>{"name":"rm","arguments":{"path":"/"}}</tool_call> here.</think>I will not.`,
		},
		{
			name:        "an unreadable span stays text rather than vanishing",
			frames:      []string{`<tool_call>not json at all</tool_call>`},
			wantCalls:   nil,
			wantVisible: `<tool_call>not json at all</tool_call>`,
		},
		{
			name:        "ordinary prose containing angle brackets is untouched",
			frames:      []string{"Use <div> and compare a < b.", " Then </div>."},
			wantCalls:   nil,
			wantVisible: "Use <div> and compare a < b. Then </div>.",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			frames := make([]string, 0, len(test.frames))
			for _, chunk := range test.frames {
				frames = append(frames, contentFrame(chunk))
			}
			var dst bytes.Buffer
			if err := WriteOpenAIChatSSE(
				context.Background(), ModeLocal, &dst, strings.NewReader(sse(frames...)), time.Second, UsageAnnotation{}, false,
			); err != nil {
				t.Fatal(err)
			}
			body := dst.String()

			for _, want := range test.wantCalls {
				if !strings.Contains(body, want) {
					t.Fatalf("missing %s in %q", want, body)
				}
			}
			if test.wantCalls == nil && strings.Contains(body, `"tool_calls"`) {
				t.Fatalf("nothing should have been executed here: %q", body)
			}
			if got := visibleContent(body); got != test.wantVisible {
				t.Fatalf("visible content was %q, want %q", got, test.wantVisible)
			}
			// Markup never reaches the user alongside a recovered call.
			if len(test.wantCalls) > 0 && strings.Contains(visibleContent(body), "<tool_call>") {
				t.Fatalf("tool markup leaked into visible content: %q", body)
			}
		})
	}
}

// Structured calls are llama.cpp's own parse and must arrive unchanged.
func TestLocalStreamLeavesStructuredToolCallsAlone(t *testing.T) {
	stream := sse(
		`data: {"choices":[{"delta":{"role":"assistant"}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"README.md\"}"}}]}}]}`,
	)
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &dst, strings.NewReader(stream), time.Second, UsageAnnotation{}, false); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if !strings.Contains(body, `"id":"call-1"`) {
		t.Fatalf("llama.cpp's own tool call was not forwarded: %q", body)
	}
	if strings.Contains(body, "heal-") {
		t.Fatalf("a structured call must not be re-emitted by the healer: %q", body)
	}
	if strings.Count(body, `"name":"read"`) != 1 {
		t.Fatalf("the call was duplicated: %q", body)
	}
}

// The server path is a shared fleet's stream and is forwarded verbatim.
func TestServerStreamIsNotHealed(t *testing.T) {
	stream := sse(contentFrame(`<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>`))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &dst, strings.NewReader(stream), time.Second, UsageAnnotation{}, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dst.String(), `"tool_calls"`) {
		t.Fatalf("the server path must not synthesize tool calls: %q", dst.String())
	}
	if visibleContent(dst.String()) != `<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>` {
		t.Fatalf("the server path must forward content unchanged: %q", dst.String())
	}
}
