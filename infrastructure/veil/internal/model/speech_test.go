package model

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTranscriptKeepsOnlyTheSpokenWords(t *testing.T) {
	for _, test := range []struct {
		name string
		in   string
		want string
	}{
		{
			name: "vLLM already strips the preamble",
			in:   "Ship it on Friday.",
			want: "Ship it on Friday.",
		},
		{
			name: "llama-server returns the whole decoder output",
			in:   "language English<asr_text>Ship it on Friday.",
			want: "Ship it on Friday.",
		},
		{
			name: "the speaker saying the marker keeps their own words",
			in:   "language English<asr_text>the tag is <asr_text> in the output",
			want: " in the output",
		},
		{
			name: "no marker at all",
			in:   "",
			want: "",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := transcriptText(test.in); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestSpeechClientAuthenticatesWhenAKeyIsConfigured(t *testing.T) {
	authorizations := make(chan string, 4)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/v1/models") {
			_, _ = w.Write([]byte(`{"data":[{"id":"qwen3-asr-1.7b"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"text":"language English<asr_text>hello"}`))
	}))
	defer runtime.Close()

	client := NewSpeechClient(runtime.URL, "qwen3-asr-1.7b", "speech-secret", 2*time.Second)
	text, err := client.Transcribe(context.Background(), make([]byte, 320), "")
	if err != nil {
		t.Fatal(err)
	}
	if text != "hello" {
		t.Fatalf("transcript was %q", text)
	}
	if got := <-authorizations; got != "Bearer speech-secret" {
		t.Fatalf("transcription was not authenticated: %q", got)
	}
	if !client.Available(context.Background()) {
		t.Fatal("a running runtime must read as available")
	}
	if got := <-authorizations; got != "Bearer speech-secret" {
		t.Fatalf("availability check was not authenticated: %q", got)
	}
}

// A company-server speech runtime is reached over the company's own network
// and usually has no key; sending an empty bearer would fail those.
func TestSpeechClientOmitsTheHeaderWithoutAKey(t *testing.T) {
	authorizations := make(chan string, 1)
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations <- r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"text":"hello"}`))
	}))
	defer runtime.Close()

	client := NewSpeechClient(runtime.URL, "asr", "", 2*time.Second)
	if _, err := client.Transcribe(context.Background(), make([]byte, 320), ""); err != nil {
		t.Fatal(err)
	}
	if got := <-authorizations; got != "" {
		t.Fatalf("an unconfigured key must not produce a header: %q", got)
	}
}
