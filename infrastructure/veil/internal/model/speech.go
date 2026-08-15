package model

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// Speech recognition against an OpenAI-compatible transcription runtime, which
// is what `vllm serve` exposes for an ASR model.
//
// The capture path sends raw samples and nothing else, so this file owns the
// single conversion between them: PCM in, a container the runtime will decode
// out. Keeping the WAV header here means the wire carries audio rather than a
// file format the renderer would have to assemble correctly.

const (
	// SpeechSampleRate is the rate capture resamples to and the rate the WAV
	// header declares. Every current ASR encoder is trained at 16 kHz mono, and
	// giving one a different rate degrades quietly rather than failing.
	SpeechSampleRate = 16000
	speechChannels   = 1
	speechSampleBits = 16

	// speechWAVHeaderBytes is the fixed canonical header this file writes.
	speechWAVHeaderBytes = 44
)

// SpeechClient calls one transcription runtime. Built once at startup like the
// chat clients, so no request assembles an endpoint from configuration.
type SpeechClient struct {
	transcribeURL string
	modelsURL     string
	model         string
	apiKey        string
	http          *http.Client
}

// NewSpeechClient resolves the runtime's routes once, through the same joiner
// the chat client uses. That matters because a base URL may or may not already
// end in /v1 — Console writes one that does — and naive concatenation turns a
// working configuration into /v1/v1/audio/transcriptions.
//
// It cannot fail in practice: configuration has already refused a base URL that
// is not an http(s) URL with a host. A resolution error still leaves the client
// inert rather than pointed somewhere unintended.
func NewSpeechClient(baseURL, modelID, apiKey string, timeout time.Duration) *SpeechClient {
	transcribeURL, _ := providerEndpointURL(baseURL, "", "v1/audio/transcriptions")
	modelsURL, _ := providerEndpointURL(baseURL, "", "v1/models")
	return &SpeechClient{
		transcribeURL: transcribeURL,
		modelsURL:     modelsURL,
		model:         strings.TrimSpace(modelID),
		apiKey:        strings.TrimSpace(apiKey),
		http:          &http.Client{Timeout: timeout},
	}
}

// authorize adds the bearer when one is configured. A company-server speech
// runtime usually has none; the desktop's own sidecar always does.
func (c *SpeechClient) authorize(request *http.Request) {
	if c.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
}

// SpeechBytesPerSecond is what one second of captured audio costs on the wire.
// Callers size their buffers and caps in seconds and convert through this
// rather than restating the arithmetic.
const SpeechBytesPerSecond = SpeechSampleRate * speechChannels * speechSampleBits / 8

// Transcribe returns the text the runtime hears in the audio captured so far.
//
// Callers pass the whole buffer every time rather than a delta. A transcript is
// not append-only: a model that has heard two more syllables must be free to
// replace "the curse of" with "recursion", and it can only do that if it still
// has the audio that produced the first guess.
func (c *SpeechClient) Transcribe(ctx context.Context, pcm []byte, language string) (string, error) {
	if len(pcm) == 0 {
		return "", nil
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "dictation.wav")
	if err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}
	if _, err := part.Write(wavPCM16(pcm)); err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}
	if err := writer.WriteField("model", c.model); err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}
	// An explicit language beats detection on short clips: a two-word utterance
	// carries little evidence, and a wrong guess returns confident text in a
	// language the speaker does not use.
	if language != "" {
		if err := writer.WriteField("language", language); err != nil {
			return "", fmt.Errorf("speech: build request: %w", err)
		}
	}
	if err := writer.WriteField("response_format", "json"); err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.transcribeURL, body)
	if err != nil {
		return "", fmt.Errorf("speech: build request: %w", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	c.authorize(request)

	response, err := c.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("speech: call runtime: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The provider body is drained but never surfaced: it can carry the
		// runtime's address, its arguments, or a prompt fragment.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("speech: runtime returned %d", response.StatusCode)
	}

	var payload struct {
		Text string `json:"text"`
	}
	decoded, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("speech: read runtime response: %w", err)
	}
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return "", errors.New("speech: runtime returned an unreadable response")
	}
	return strings.TrimSpace(transcriptText(payload.Text)), nil
}

// asrTextMarker separates Qwen3-ASR's own preamble from the words that were
// spoken. llama.cpp currently returns the whole decoder output — "language
// English<asr_text>hello there" (ggml-org/llama.cpp#26749) — while vLLM strips
// it upstream, so this is a no-op on the company-server path.
const asrTextMarker = "<asr_text>"

// transcriptText keeps only what follows the last marker. The last, not the
// first: a speaker who says the marker aloud gets it transcribed inside the
// text, and taking the first occurrence would then discard their own words.
func transcriptText(text string) string {
	at := strings.LastIndex(text, asrTextMarker)
	if at < 0 {
		return text
	}
	return text[at+len(asrTextMarker):]
}

// Available reports whether the transcription runtime answers right now, so a
// stopped ASR model dims the microphone instead of failing on first press.
func (c *SpeechClient) Available(ctx context.Context) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.modelsURL, nil)
	if err != nil {
		return false
	}
	c.authorize(request)
	response, err := c.http.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode >= 200 && response.StatusCode < 300
}

// wavPCM16 wraps little-endian 16-bit samples in the smallest valid WAV
// container. Written by hand rather than pulled in: it is 44 fixed bytes, and
// Veil carries no third-party Go modules.
func wavPCM16(pcm []byte) []byte {
	const byteRate = uint32(SpeechSampleRate * speechChannels * speechSampleBits / 8)
	const blockAlign = uint16(speechChannels * speechSampleBits / 8)

	out := make([]byte, 0, speechWAVHeaderBytes+len(pcm))
	out = append(out, "RIFF"...)
	out = binary.LittleEndian.AppendUint32(out, uint32(36+len(pcm)))
	out = append(out, "WAVE"...)
	out = append(out, "fmt "...)
	out = binary.LittleEndian.AppendUint32(out, 16)
	out = binary.LittleEndian.AppendUint16(out, 1) // PCM, uncompressed
	out = binary.LittleEndian.AppendUint16(out, speechChannels)
	out = binary.LittleEndian.AppendUint32(out, SpeechSampleRate)
	out = binary.LittleEndian.AppendUint32(out, byteRate)
	out = binary.LittleEndian.AppendUint16(out, blockAlign)
	out = binary.LittleEndian.AppendUint16(out, speechSampleBits)
	out = append(out, "data"...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(pcm)))
	return append(out, pcm...)
}
