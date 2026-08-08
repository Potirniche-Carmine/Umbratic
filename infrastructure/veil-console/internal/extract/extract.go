// Package extract turns an uploaded document into located text segments.
//
// Every input here is hostile until proven otherwise: the file arrives over an
// authenticated upload but its bytes are attacker-shaped. The type is decided
// by content rather than by the name the browser sent, sizes are capped before
// any allocation that depends on them, and the one format that needs a real
// parser (PDF) is handled out of process by the existing Rust extractor.
package extract

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// MaxFileBytes matches the PDF extractor's own default byte cap, so no accepted
// upload can be one the extractor will refuse.
const MaxFileBytes = 25 << 20

// maxSegmentBytes bounds the text taken from any one located section, and
// maxDocumentBytes bounds a whole document's extracted text. A ZIP entry can
// claim to be small and decompress to gigabytes; these caps are what make that
// claim irrelevant.
const (
	maxSegmentBytes  = 1 << 20
	maxDocumentBytes = 8 << 20
)

// Segment is a run of text with the locator a citation shows: a page for PDF, a
// slide for PPTX, a sheet and row range for XLSX, the nearest heading for
// Markdown and DOCX.
type Segment struct {
	Locator string
	Text    string
}

const (
	KindMarkdown = "md"
	KindText     = "txt"
	KindPDF      = "pdf"
	KindDOCX     = "docx"
	KindPPTX     = "pptx"
	KindXLSX     = "xlsx"
)

var ErrUnsupported = errors.New("file type is not supported")

// Kind identifies the document type from its bytes. The file name only chooses
// between two types that are byte-identical to a sniffer (Markdown and plain
// text), and never decides whether a file is parsed as an archive or a PDF.
func Kind(data []byte, name string) (string, error) {
	switch {
	case len(data) == 0:
		return "", errors.New("file is empty")
	case len(data) > MaxFileBytes:
		return "", errors.New("file is larger than 25 MiB")
	case hasPrefix(data, "%PDF-"):
		return KindPDF, nil
	case hasPrefix(data, "PK\x03\x04"), hasPrefix(data, "PK\x05\x06"):
		return ooxmlKind(data)
	case utf8.Valid(data) && !hasNUL(data):
		if strings.EqualFold(extension(name), ".md") || strings.EqualFold(extension(name), ".markdown") {
			return KindMarkdown, nil
		}
		return KindText, nil
	default:
		return "", ErrUnsupported
	}
}

// Options names one document to extract. Path is the stored original, which
// only the PDF extractor needs: it runs out of process and reads the file
// itself rather than taking 25 MiB through a pipe.
type Options struct {
	Kind      string
	Data      []byte
	Path      string
	PDFBinary string
}

// Segments extracts located text from one document.
func Segments(ctx context.Context, opts Options) ([]Segment, error) {
	var segments []Segment
	var err error
	switch opts.Kind {
	case KindMarkdown, KindText:
		segments, err = plainSegments(string(opts.Data))
	case KindPDF:
		segments, err = pdfSegments(ctx, opts.Path, opts.PDFBinary)
	case KindDOCX, KindPPTX, KindXLSX:
		segments, err = ooxmlSegments(opts.Kind, opts.Data)
	default:
		return nil, ErrUnsupported
	}
	if err != nil {
		return nil, err
	}
	segments = bound(segments)
	if len(segments) == 0 {
		return nil, errors.New("no readable text was found in this document")
	}
	return segments, nil
}

// plainSegments splits Markdown and text on headings so a citation can name the
// section a chunk came from. Text without headings is one segment.
func plainSegments(body string) ([]Segment, error) {
	lines := strings.Split(clean(body), "\n")
	segments := []Segment{}
	locator := ""
	var current strings.Builder
	flush := func() {
		if strings.TrimSpace(current.String()) != "" {
			segments = append(segments, Segment{Locator: locator, Text: current.String()})
		}
		current.Reset()
	}
	for _, line := range lines {
		if heading := markdownHeading(line); heading != "" {
			flush()
			locator = heading
			continue
		}
		current.WriteString(line)
		current.WriteByte('\n')
	}
	flush()
	return segments, nil
}

func markdownHeading(line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "#") {
		return ""
	}
	heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
	if heading == "" || len(heading) > 120 {
		return ""
	}
	return heading
}

// clean drops control characters that would otherwise reach a prompt, and
// normalizes line endings so chunk boundaries are predictable across platforms.
func clean(value string) string {
	if !utf8.ValidString(value) {
		value = strings.ToValidUTF8(value, "")
	}
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r < 0x20 || r == 0x7f:
			return -1
		default:
			return r
		}
	}, value)
}

func bound(segments []Segment) []Segment {
	total := 0
	bounded := make([]Segment, 0, len(segments))
	for _, segment := range segments {
		text := strings.TrimSpace(clean(segment.Text))
		if text == "" {
			continue
		}
		if len(text) > maxSegmentBytes {
			text = truncateUTF8(text, maxSegmentBytes)
		}
		if total+len(text) > maxDocumentBytes {
			text = truncateUTF8(text, maxDocumentBytes-total)
			if strings.TrimSpace(text) == "" {
				break
			}
		}
		total += len(text)
		bounded = append(bounded, Segment{Locator: boundedLocator(segment.Locator), Text: text})
		if total >= maxDocumentBytes {
			break
		}
	}
	return bounded
}

func boundedLocator(locator string) string {
	locator = strings.TrimSpace(clean(strings.ReplaceAll(locator, "\n", " ")))
	if len(locator) > 120 {
		return truncateUTF8(locator, 120)
	}
	return locator
}

func truncateUTF8(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		if limit <= 0 {
			return ""
		}
		return value
	}
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit]
}

func hasPrefix(data []byte, prefix string) bool {
	return len(data) >= len(prefix) && string(data[:len(prefix)]) == prefix
}

func hasNUL(data []byte) bool {
	for _, b := range data {
		if b == 0 {
			return true
		}
	}
	return false
}

func extension(name string) string {
	if index := strings.LastIndexByte(name, '.'); index >= 0 {
		return name[index:]
	}
	return ""
}
