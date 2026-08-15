package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"umbratic-veil/internal/model"
)

const (
	// maxSpeechSeconds caps one dictation. Long enough for a paragraph of
	// prompt, short enough that a microphone left open by accident cannot hold
	// a runtime slot for the rest of the afternoon.
	maxSpeechSeconds = 120
	maxSpeechBytes   = maxSpeechSeconds * model.SpeechBytesPerSecond

	// speechPartialInterval is how often the audio so far is re-transcribed
	// while the speaker is still going. Short enough that text tracks speech,
	// long enough that one pass usually finishes before the next is due.
	speechPartialInterval = 900 * time.Millisecond

	// speechMinPartialBytes withholds the first guess until there is enough
	// audio to make one worth showing. Below about half a second a model
	// returns confident nonsense, and a wrong first word is more distracting
	// than a short wait.
	speechMinPartialBytes = model.SpeechBytesPerSecond / 2

	// speechReadChunkBytes is the body read size: a fifth of a second of audio,
	// so a slow speaker still produces frequent progress.
	speechReadChunkBytes = model.SpeechBytesPerSecond / 5

	// maxSpeechLanguageBytes bounds the language hint. It is a tag, not text.
	maxSpeechLanguageBytes = 16
)

// speechText is one transcript event. `truncated` tells the client the cap was
// reached, so it can say the recording was cut rather than let the user think
// the tail was misheard.
type speechText struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

// handleTranscribe turns a stream of captured microphone audio into a stream of
// transcripts.
//
// The request body arrives for as long as the user speaks and the response
// streams back over the same exchange, so a dictation is one connection rather
// than a poll. Each pass re-transcribes everything captured so far instead of
// only the newest slice: a transcript is not append-only, and a model that has
// heard two more syllables has to be free to revise the words it already
// emitted.
func (s *Server) handleTranscribe(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.SpeechEnabled() || s.speech == nil {
		writeCodedError(w, http.StatusNotFound, "speech_unconfigured", "Dictation is not configured on this server.")
		return
	}
	language, ok := speechLanguage(w, r.URL.Query().Get("language"))
	if !ok {
		return
	}

	lease, ok := s.admitModelWork(w, r)
	if !ok {
		return
	}
	defer lease.release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeCodedError(w, http.StatusInternalServerError, "stream_unsupported", "Streaming is unavailable.")
		return
	}

	// Dictation is the one endpoint here that reads its request while writing
	// its response. By default net/http assumes a handler is done reading once
	// it starts replying and aborts the pending body read, which turns a live
	// recording into a few kilobytes and an "invalid Read on closed Body". Full
	// duplex has to be asked for explicitly, and it is the whole protocol on
	// this route.
	controller := http.NewResponseController(w)
	if err := controller.EnableFullDuplex(); err != nil {
		writeCodedError(w, http.StatusInternalServerError, "stream_unsupported", "Streaming is unavailable.")
		return
	}
	// The server's read timeout is sized for a JSON body that arrives at once,
	// not for someone speaking. Left alone it ends the recording mid-sentence,
	// so this route extends it to cover the cap it actually enforces.
	if err := controller.SetReadDeadline(time.Now().Add(maxSpeechSeconds*time.Second + 15*time.Second)); err != nil {
		writeCodedError(w, http.StatusInternalServerError, "stream_unsupported", "Streaming is unavailable.")
		return
	}

	// The recording bounds the exchange, plus one model timeout for the final
	// pass that runs after the speaker stops.
	ctx, cancel := context.WithTimeout(r.Context(), maxSpeechSeconds*time.Second+s.cfg.ModelTimeout)
	defer cancel()

	// Capture starts before the first byte of response so the recording is
	// already draining when the headers go out, which is also what lets a
	// client using `Expect: 100-continue` get its continue.
	capture := newSpeechCapture(r.Body)
	go capture.read(ctx)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ticker := time.NewTicker(speechPartialInterval)
	defer ticker.Stop()

	transcribedBytes := 0
	for {
		select {
		case <-ctx.Done():
			return

		case <-capture.done:
			pcm, truncated, readErr := capture.snapshot()
			if readErr != nil && len(pcm) == 0 {
				writeSpeechEvent(w, flusher, "error", map[string]string{
					"code":    "speech_capture_failed",
					"message": "The recording did not arrive.",
				})
				return
			}
			text, err := s.speech.Transcribe(ctx, pcm, language)
			if err != nil {
				writeSpeechEvent(w, flusher, "error", map[string]string{
					"code":    "speech_failed",
					"message": "The dictation could not be transcribed.",
				})
				return
			}
			writeSpeechEvent(w, flusher, "final", speechText{Text: text, Truncated: truncated})
			return

		case <-ticker.C:
			pcm, _, _ := capture.snapshot()
			if len(pcm) < speechMinPartialBytes || len(pcm) == transcribedBytes {
				continue
			}
			transcribedBytes = len(pcm)
			text, err := s.speech.Transcribe(ctx, pcm, language)
			if err != nil {
				// A dropped partial costs one beat of feedback, not the
				// dictation: the final pass still holds every sample.
				continue
			}
			writeSpeechEvent(w, flusher, "partial", speechText{Text: text})
		}
	}
}

// speechCapture accumulates the request body while the handler transcribes from
// it. The body keeps arriving for as long as the user speaks, so reading it and
// transcribing it cannot be the same goroutine.
type speechCapture struct {
	body io.Reader
	done chan struct{}

	mu        sync.Mutex
	pcm       []byte
	truncated bool
	err       error
}

func newSpeechCapture(body io.Reader) *speechCapture {
	return &speechCapture{body: body, done: make(chan struct{})}
}

func (c *speechCapture) read(ctx context.Context) {
	defer close(c.done)
	buf := make([]byte, speechReadChunkBytes)
	for {
		read, err := c.body.Read(buf)
		if read > 0 {
			c.mu.Lock()
			if len(c.pcm)+read > maxSpeechBytes {
				read = maxSpeechBytes - len(c.pcm)
				c.truncated = true
			}
			if read > 0 {
				c.pcm = append(c.pcm, buf[:read]...)
			}
			full := c.truncated
			c.mu.Unlock()
			if full {
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				c.mu.Lock()
				c.err = err
				c.mu.Unlock()
			}
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// snapshot copies the audio captured so far. The length is trimmed to a whole
// number of samples: a read can land mid-sample, and half a frame at the end
// shifts every byte of the WAV body that follows it.
func (c *speechCapture) snapshot() ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	usable := len(c.pcm) - len(c.pcm)%2
	out := make([]byte, usable)
	copy(out, c.pcm[:usable])
	return out, c.truncated, c.err
}

func writeSpeechEvent(w http.ResponseWriter, flusher http.Flusher, event string, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = io.WriteString(w, "event: "+event+"\ndata: "+string(encoded)+"\n\n")
	flusher.Flush()
}

// speechLanguage bounds the hint to the shape of a BCP 47 tag. It reaches the
// runtime as a form field, so it is validated here rather than trusted for
// being short.
func speechLanguage(w http.ResponseWriter, raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", true
	}
	if len(value) > maxSpeechLanguageBytes {
		writeCodedError(w, http.StatusBadRequest, "speech_language_invalid", "The dictation language is not a valid tag.")
		return "", false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char == '-' {
			continue
		}
		writeCodedError(w, http.StatusBadRequest, "speech_language_invalid", "The dictation language is not a valid tag.")
		return "", false
	}
	return strings.ToLower(value), true
}
