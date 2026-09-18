package supervisor

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"time"

	"umbratic-veil-console/internal/config"
)

// Probe the role's real endpoint before declaring a runtime healthy.
func probeModelRole(ctx context.Context, model config.ManagedModel) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var path, kind string
	var body []byte
	switch config.NormalizeRole(model.Role) {
	case config.RoleSpeech:
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		_ = writer.WriteField("model", model.ID)
		part, err := writer.CreateFormFile("file", "readiness.wav")
		if err != nil {
			return err
		}
		// Half a second of PCM silence exercises decoding without customer audio.
		wav := make([]byte, 44+16000)
		copy(wav, "RIFF")
		binary.LittleEndian.PutUint32(wav[4:], uint32(len(wav)-8))
		copy(wav[8:], "WAVEfmt ")
		binary.LittleEndian.PutUint32(wav[16:], 16)
		binary.LittleEndian.PutUint16(wav[20:], 1)
		binary.LittleEndian.PutUint16(wav[22:], 1)
		binary.LittleEndian.PutUint32(wav[24:], 16000)
		binary.LittleEndian.PutUint32(wav[28:], 32000)
		binary.LittleEndian.PutUint16(wav[32:], 2)
		binary.LittleEndian.PutUint16(wav[34:], 16)
		copy(wav[36:], "data")
		binary.LittleEndian.PutUint32(wav[40:], 16000)
		if _, err = part.Write(wav); err != nil {
			return err
		}
		if err = writer.Close(); err != nil {
			return err
		}
		body = buffer.Bytes()
		kind = writer.FormDataContentType()
		path = "/audio/transcriptions"
	case config.RoleEmbedding:
		body, _ = json.Marshal(map[string]any{"model": model.ID, "input": []string{"ready"}})
		kind = "application/json"
		path = "/embeddings"
	default:
		body, _ = json.Marshal(map[string]any{"model": model.ID, "messages": []map[string]string{{"role": "user", "content": "Reply ready."}}, "max_tokens": 8, "chat_template_kwargs": map[string]bool{"enable_thinking": false}})
		kind = "application/json"
		path = "/chat/completions"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, model.ProviderBaseURL()+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", kind)
	client := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("the model's " + config.NormalizeRole(model.Role) + " endpoint did not respond")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("the model's " + config.NormalizeRole(model.Role) + " endpoint returned HTTP " + strconv.Itoa(response.StatusCode) + "; check its architecture, quantization, and runtime output")
	}
	var payload struct {
		Choices []json.RawMessage `json:"choices"`
		Data    []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
		Text *string `json:"text"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload) != nil {
		return errors.New("the model returned an invalid endpoint response")
	}
	switch config.NormalizeRole(model.Role) {
	case config.RoleSpeech:
		if payload.Text == nil {
			return errors.New("transcription response has no text field")
		}
	case config.RoleEmbedding:
		if len(payload.Data) == 0 || len(payload.Data[0].Embedding) == 0 {
			return errors.New("embedding response has no vectors")
		}
	default:
		if len(payload.Choices) == 0 {
			return errors.New("chat response has no choices")
		}
	}
	return nil
}
