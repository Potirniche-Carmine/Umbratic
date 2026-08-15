package httpapi

import (
	"bytes"
	"encoding/binary"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
)

// Dictation is tested over a real socket rather than through a
// ResponseRecorder. It is the one route that reads its request while writing
// its response, and a recorder cannot express that: it reports full duplex as
// unsupported and never aborts a pending body read, so it passes a handler that
// truncates every real recording to whatever happened to be buffered.

type fakeSpeechRuntime struct {
	server *httptest.Server

	status int
	text   string

	calls     int
	lastModel string
	lastLang  string
	lastWAV   []byte
	lastPath  string
}

func newFakeSpeechRuntime(t *testing.T) *fakeSpeechRuntime {
	t.Helper()
	runtime := &fakeSpeechRuntime{status: http.StatusOK, text: "refactor the auth middleware"}
	runtime.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		runtime.lastPath = r.URL.Path
		if r.URL.Path != "/v1/audio/transcriptions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			return
		}
		reader := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			body, _ := io.ReadAll(part)
			switch part.FormName() {
			case "file":
				runtime.lastWAV = body
			case "model":
				runtime.lastModel = string(body)
			case "language":
				runtime.lastLang = string(body)
			}
		}
		runtime.calls++
		if runtime.status != http.StatusOK {
			w.WriteHeader(runtime.status)
			// A body a leaky proxy would happily forward to the client.
			_, _ = io.WriteString(w, `{"error":"model qwen3-asr not loaded at 10.0.0.4:8010"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"`+runtime.text+`"}`)
	}))
	t.Cleanup(runtime.server.Close)
	return runtime
}

func speechConfig(runtimeURL string) config.Config {
	cfg := testConfig()
	cfg.SpeechBaseURL = runtimeURL
	cfg.SpeechModel = "qwen3-asr"
	cfg.ModelTimeout = 5 * time.Second
	return cfg
}

// veilFor starts the API on a real listener, which is what makes the duplex
// behavior under test observable at all.
func veilFor(t *testing.T, cfg config.Config) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(NewServer(cfg, &fakeModelClient{}))
	t.Cleanup(server.Close)
	return server
}

// silence returns whole 16-bit samples, so a test never accidentally exercises
// the odd-length trim it is not asking about.
func silence(seconds float64) []byte {
	samples := int(float64(model.SpeechBytesPerSecond) * seconds)
	return make([]byte, samples-samples%2)
}

func transcribe(t *testing.T, veil *httptest.Server, body io.Reader, query string) (int, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, veil.URL+"/api/transcribe"+query, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer test-token")
	request.Header.Set("Content-Type", "application/octet-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(payload)
}

// speaking returns a body that delivers audio over time and then ends, which is
// the shape a live recording actually has.
func speaking(seconds float64, hold time.Duration) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		_, _ = writer.Write(silence(seconds))
		time.Sleep(hold)
		_ = writer.Close()
	}()
	return reader
}

func TestTranscribeIsAbsentWithoutASpeechRuntime(t *testing.T) {
	veil := veilFor(t, testConfig())

	status, body := transcribe(t, veil, bytes.NewReader(silence(1)), "")
	if status != http.StatusNotFound {
		t.Fatalf("an unconfigured deployment has no dictation route: %d", status)
	}
	if !strings.Contains(body, "speech_unconfigured") {
		t.Fatalf("the refusal needs a stable code: %s", body)
	}
}

func TestTranscribeRequiresAuthAndPOST(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	unauthorized, err := http.Post(veil.URL+"/api/transcribe", "application/octet-stream", bytes.NewReader(silence(1)))
	if err != nil {
		t.Fatal(err)
	}
	defer unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dictation is product-authenticated: %d", unauthorized.StatusCode)
	}

	getRequest, _ := http.NewRequest(http.MethodGet, veil.URL+"/api/transcribe", nil)
	getRequest.Header.Set("Authorization", "Bearer test-token")
	wrongMethod, err := http.DefaultClient.Do(getRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer wrongMethod.Body.Close()
	if wrongMethod.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("audio only arrives by POST: %d", wrongMethod.StatusCode)
	}

	if runtime.calls != 0 {
		t.Fatalf("a refused request must never reach the runtime: %d calls", runtime.calls)
	}
}

func TestTranscribeStreamsAFinalTranscript(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	_, body := transcribe(t, veil, bytes.NewReader(silence(1)), "?language=EN")
	if !strings.Contains(body, "event: final") {
		t.Fatalf("a completed recording ends in a final event: %s", body)
	}
	if !strings.Contains(body, "refactor the auth middleware") {
		t.Fatalf("the transcript must reach the client: %s", body)
	}
	if runtime.lastModel != "qwen3-asr" {
		t.Fatalf("the configured model names the runtime call: %q", runtime.lastModel)
	}
	if runtime.lastLang != "en" {
		t.Fatalf("the language hint is normalized and forwarded: %q", runtime.lastLang)
	}
}

// The whole recording has to arrive, not just what was buffered when the
// response started. This is the case a ResponseRecorder cannot fail on.
func TestTranscribeReceivesTheWholeRecording(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	pcm := silence(8)
	if _, body := transcribe(t, veil, speaking(8, 150*time.Millisecond), ""); !strings.Contains(body, "event: final") {
		t.Fatalf("the recording must finalize: %s", body)
	}
	if got := len(runtime.lastWAV) - 44; got != len(pcm) {
		t.Fatalf("the runtime must receive every sample: got %d of %d bytes", got, len(pcm))
	}
}

// Console writes a base URL that already ends in /v1. Concatenating the route
// onto it would ask for /v1/v1/audio/transcriptions and 404 on every dictation.
func TestTranscribeResolvesTheRouteWithOrWithoutAVersionedBase(t *testing.T) {
	for _, suffix := range []string{"", "/v1"} {
		runtime := newFakeSpeechRuntime(t)
		veil := veilFor(t, speechConfig(runtime.server.URL+suffix))

		_, body := transcribe(t, veil, bytes.NewReader(silence(1)), "")
		if !strings.Contains(body, "refactor the auth middleware") {
			t.Fatalf("base %q did not reach the runtime: %s (asked for %q)", suffix, body, runtime.lastPath)
		}
		if runtime.lastPath != "/v1/audio/transcriptions" {
			t.Fatalf("base %q resolved to %q", suffix, runtime.lastPath)
		}
	}
}

func TestTranscribeSendsAValidWAVToTheRuntime(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	pcm := silence(0.5)
	transcribe(t, veil, bytes.NewReader(pcm), "")

	wav := runtime.lastWAV
	if len(wav) != len(pcm)+44 {
		t.Fatalf("a canonical WAV is 44 bytes of header plus the samples: got %d for %d samples", len(wav), len(pcm))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" || string(wav[12:16]) != "fmt " {
		t.Fatalf("header chunks are wrong: %q", wav[:16])
	}
	if got := binary.LittleEndian.Uint16(wav[22:24]); got != 1 {
		t.Fatalf("dictation is mono: %d channels", got)
	}
	if got := binary.LittleEndian.Uint32(wav[24:28]); got != model.SpeechSampleRate {
		t.Fatalf("the header must declare the rate capture actually used: %d", got)
	}
	if got := binary.LittleEndian.Uint32(wav[40:44]); int(got) != len(pcm) {
		t.Fatalf("the data chunk length must match the samples: %d for %d", got, len(pcm))
	}
}

func TestTranscribeEmitsPartialsWhileTheSpeakerContinues(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	_, body := transcribe(t, veil, speaking(1, 1300*time.Millisecond), "")
	if !strings.Contains(body, "event: partial") {
		t.Fatalf("text has to appear before the speaker stops: %s", body)
	}
	if !strings.Contains(body, "event: final") {
		t.Fatalf("the stream still has to finalize: %s", body)
	}
	if strings.Index(body, "event: partial") > strings.Index(body, "event: final") {
		t.Fatalf("partials precede the final: %s", body)
	}
}

func TestTranscribeWithheldAudioProducesNoPartial(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	// A tenth of a second is below the guess threshold. It still finalizes, but
	// it must never produce a confident partial from almost no evidence.
	_, body := transcribe(t, veil, speaking(0.1, 1300*time.Millisecond), "")
	if strings.Contains(body, "event: partial") {
		t.Fatalf("too little audio must not be guessed at: %s", body)
	}
}

func TestTranscribeRejectsAMalformedLanguage(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	veil := veilFor(t, speechConfig(runtime.server.URL))

	// Semicolons are absent on purpose: Go drops a query parameter containing
	// one before a handler sees it, so that shape is already inert and would
	// test the standard library rather than this validator.
	for _, bad := range []string{"?language=en_US", "?language=" + strings.Repeat("e", 40), "?language=en%20US", "?language=en."} {
		status, body := transcribe(t, veil, bytes.NewReader(silence(1)), bad)
		if status != http.StatusBadRequest {
			t.Fatalf("%q is not a language tag: %d", bad, status)
		}
		if !strings.Contains(body, "speech_language_invalid") {
			t.Fatalf("%q needs a stable refusal code: %s", bad, body)
		}
	}
	if runtime.calls != 0 {
		t.Fatalf("a rejected tag must never reach the runtime: %d calls", runtime.calls)
	}
}

func TestTranscribeHidesRuntimeFailureDetail(t *testing.T) {
	runtime := newFakeSpeechRuntime(t)
	runtime.status = http.StatusInternalServerError
	veil := veilFor(t, speechConfig(runtime.server.URL))

	_, body := transcribe(t, veil, bytes.NewReader(silence(1)), "")
	if !strings.Contains(body, "event: error") || !strings.Contains(body, "speech_failed") {
		t.Fatalf("a runtime failure reaches the client as a stable error: %s", body)
	}
	for _, leak := range []string{"10.0.0.4", "8010", "not loaded"} {
		if strings.Contains(body, leak) {
			t.Fatalf("the provider body must not be forwarded, found %q in: %s", leak, body)
		}
	}
}

func TestTranscribeTrimsAPartialSampleAndCapsTheRecording(t *testing.T) {
	capture := newSpeechCapture(bytes.NewReader([]byte{1, 2, 3}))
	capture.read(t.Context())
	pcm, truncated, err := capture.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(pcm) != 2 {
		t.Fatalf("a half sample at the tail is dropped, not padded: %d bytes", len(pcm))
	}
	if truncated {
		t.Fatal("three bytes is not the cap")
	}

	over := newSpeechCapture(bytes.NewReader(make([]byte, maxSpeechBytes+4096)))
	over.read(t.Context())
	pcm, truncated, err = over.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("passing the cap has to be reported, not silently dropped")
	}
	if len(pcm) != maxSpeechBytes {
		t.Fatalf("capture stops at the cap: %d bytes", len(pcm))
	}
}
