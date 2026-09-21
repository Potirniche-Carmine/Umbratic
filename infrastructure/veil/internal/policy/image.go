package policy

import (
	"encoding/json"
	"errors"
	"strings"
	"umbratic-veil/internal/model"
)

func DecodeImageInput(raw map[string]json.RawMessage) (model.ImageRequest, error) {
	for _, field := range []string{"system", "model", "provider", "runtime", "binary", "weights", "encoder", "vae"} {
		if _, exists := raw[field]; exists {
			return model.ImageRequest{}, errors.New("protected image override")
		}
	}
	stripUnknownFields(raw, "prompt", "width", "height")
	data, _ := json.Marshal(raw)
	input := model.ImageRequest{Width: 512, Height: 512}
	if json.Unmarshal(data, &input) != nil || len(strings.TrimSpace(input.Prompt)) == 0 || len(input.Prompt) > 8000 ||
		input.Width < 256 || input.Width > 1024 || input.Height < 256 || input.Height > 1024 || input.Width%32 != 0 || input.Height%32 != 0 {
		return model.ImageRequest{}, errors.New("invalid image request")
	}
	return input, nil
}
