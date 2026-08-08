package extract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// PDF parsing is the one job Console does not do itself. `umbratic-pdf` already
// parses hostile PDFs behind catch_unwind with byte and page caps, and the
// desktop already spawns it exactly this way, so Console reuses the binary
// instead of growing a PDF parser in Go.
const (
	pdfTimeout     = 60 * time.Second
	pdfOutputBytes = 24 << 20
	pageMarker     = "--- Page "
)

func pdfSegments(ctx context.Context, path, binary string) ([]Segment, error) {
	if strings.TrimSpace(binary) == "" {
		return nil, errors.New("the PDF extractor is not installed on this server")
	}
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("the stored document could not be located")
	}
	runCtx, cancel := context.WithTimeout(ctx, pdfTimeout)
	defer cancel()
	command := exec.CommandContext(runCtx, binary, "inspect", "--full",
		"--max-bytes", strconv.Itoa(MaxFileBytes), path)
	command.Env = []string{}
	command.Stdin = nil
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	runErr := command.Run()
	if runCtx.Err() != nil {
		return nil, errors.New("PDF extraction timed out")
	}

	var payload struct {
		Markdown *string `json:"markdown"`
		Error    *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(&stdout, pdfOutputBytes))
	if err := decoder.Decode(&payload); err != nil {
		if runErr != nil {
			return nil, errors.New("the PDF could not be read")
		}
		return nil, errors.New("the PDF extractor returned an unreadable result")
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("the PDF could not be read (%s)", payload.Error.Code)
	}
	if runErr != nil || payload.Markdown == nil {
		return nil, errors.New("the PDF could not be read")
	}
	return pageSegments(*payload.Markdown), nil
}

// pageSegments splits the extractor's markdown on its own page markers so each
// chunk carries the page it came from.
func pageSegments(markdown string) []Segment {
	segments := []Segment{}
	locator := "page 1"
	var body strings.Builder
	flush := func() {
		if strings.TrimSpace(body.String()) != "" {
			segments = append(segments, Segment{Locator: locator, Text: body.String()})
		}
		body.Reset()
	}
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, pageMarker) && strings.HasSuffix(trimmed, "---") {
			number := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, pageMarker), "---"))
			if _, err := strconv.Atoi(number); err == nil {
				flush()
				locator = "page " + number
				continue
			}
		}
		body.WriteString(line)
		body.WriteByte('\n')
	}
	flush()
	return segments
}
