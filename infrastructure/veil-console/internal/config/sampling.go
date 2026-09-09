package config

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
)

type SamplingProfile struct {
	Temperature       float64 `json:"temperature"`
	TopP              float64 `json:"top_p"`
	TopK              int     `json:"top_k"`
	MinP              float64 `json:"min_p"`
	PresencePenalty   float64 `json:"presence_penalty"`
	RepetitionPenalty float64 `json:"repetition_penalty"`
}

type SamplingProfiles struct {
	Thinking    SamplingProfile `json:"thinking"`
	NonThinking SamplingProfile `json:"non_thinking"`
}

func (p SamplingProfiles) Validate() error {
	for _, s := range []SamplingProfile{p.Thinking, p.NonThinking} {
		for _, v := range []float64{s.Temperature, s.TopP, s.MinP, s.PresencePenalty, s.RepetitionPenalty} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return errors.New("sampling values must be finite")
			}
		}
		if s.Temperature < 0 || s.Temperature > 2 || s.TopP <= 0 || s.TopP > 1 || s.TopK < 0 || s.TopK > 100000 || s.MinP < 0 || s.MinP > 1 || s.PresencePenalty < -2 || s.PresencePenalty > 2 || s.RepetitionPenalty <= 0 || s.RepetitionPenalty > 2 {
			return errors.New("invalid sampling profile: check temperature, probabilities, top_k and penalties")
		}
	}
	return nil
}

func (m ManagedModel) Sampling() (*SamplingProfiles, error) {
	if m.SamplingJSON == "" {
		return nil, nil
	}
	if len(m.SamplingJSON) > 4096 {
		return nil, errors.New("sampling settings are too large")
	}
	var profiles SamplingProfiles
	decoder := json.NewDecoder(strings.NewReader(m.SamplingJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&profiles); err != nil {
		return nil, errors.New("sampling settings must contain thinking and non_thinking profiles")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("sampling settings must be one JSON object")
	}
	if err := profiles.Validate(); err != nil {
		return nil, err
	}
	return &profiles, nil
}
