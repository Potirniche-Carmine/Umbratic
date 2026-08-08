package extract

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// OOXML is ZIP plus XML, both of which the standard library already reads, so
// the three Office formats cost no dependency. What they do cost is care: a
// small archive can declare enormous entries, so every read is capped and the
// entry count is bounded before anything is decompressed.
const (
	maxArchiveEntries = 4096
	maxEntryBytes     = 16 << 20
	maxArchiveText    = maxDocumentBytes
	// Rows per XLSX segment. Small enough that a citation names a useful row
	// range, large enough that a sheet does not explode into hundreds of them.
	xlsxRowsPerSegment = 40
)

func ooxmlKind(data []byte) (string, error) {
	archive, err := openArchive(data)
	if err != nil {
		return "", err
	}
	names := map[string]bool{}
	for _, file := range archive.File {
		names[file.Name] = true
	}
	switch {
	case names["word/document.xml"]:
		return KindDOCX, nil
	case names["xl/workbook.xml"]:
		return KindXLSX, nil
	default:
		for name := range names {
			if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
				return KindPPTX, nil
			}
		}
	}
	return "", ErrUnsupported
}

func openArchive(data []byte) (*zip.Reader, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("file is not a readable Office document")
	}
	if len(archive.File) > maxArchiveEntries {
		return nil, errors.New("Office document has too many parts")
	}
	return archive, nil
}

func ooxmlSegments(kind string, data []byte) ([]Segment, error) {
	archive, err := openArchive(data)
	if err != nil {
		return nil, err
	}
	switch kind {
	case KindDOCX:
		return docxSegments(archive)
	case KindPPTX:
		return pptxSegments(archive)
	case KindXLSX:
		return xlsxSegments(archive)
	default:
		return nil, ErrUnsupported
	}
}

// entry reads one archive part under the decompressed-size cap. A missing part
// is not an error for optional parts; callers decide.
func entry(archive *zip.Reader, name string) ([]byte, error) {
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return nil, errors.New("Office document part could not be read")
		}
		defer reader.Close()
		payload, err := io.ReadAll(io.LimitReader(reader, maxEntryBytes+1))
		if err != nil {
			return nil, errors.New("Office document part could not be read")
		}
		if len(payload) > maxEntryBytes {
			return nil, errors.New("Office document part is too large")
		}
		return payload, nil
	}
	return nil, nil
}

// docxSegments walks word/document.xml, keeping paragraph text and starting a
// new located segment whenever a heading paragraph appears.
func docxSegments(archive *zip.Reader) ([]Segment, error) {
	payload, err := entry(archive, "word/document.xml")
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, errors.New("Word document is missing its body")
	}
	decoder := xml.NewDecoder(bytes.NewReader(payload))
	segments := []Segment{}
	locator := ""
	var body strings.Builder
	var paragraph strings.Builder
	isHeading := false
	inText := false
	flush := func() {
		if strings.TrimSpace(body.String()) != "" {
			segments = append(segments, Segment{Locator: locator, Text: body.String()})
		}
		body.Reset()
	}
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("Word document XML is invalid")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "p":
				paragraph.Reset()
				isHeading = false
			case "pStyle":
				isHeading = isHeading || headingStyle(attribute(typed, "val"))
			case "t":
				inText = true
			case "tab":
				paragraph.WriteByte('\t')
			case "br", "cr":
				paragraph.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				paragraph.Write(typed)
			}
		case xml.EndElement:
			switch typed.Name.Local {
			case "t":
				inText = false
			case "p":
				text := strings.TrimSpace(paragraph.String())
				if isHeading && text != "" {
					flush()
					locator = text
					continue
				}
				body.WriteString(paragraph.String())
				body.WriteByte('\n')
				if body.Len() > maxArchiveText {
					flush()
					return segments, nil
				}
			}
		}
	}
	flush()
	return segments, nil
}

func headingStyle(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "heading") || strings.HasPrefix(value, "title")
}

func attribute(element xml.StartElement, name string) string {
	for _, attr := range element.Attr {
		if attr.Name.Local == name {
			return attr.Value
		}
	}
	return ""
}

// pptxSegments produces one segment per slide, in slide order.
func pptxSegments(archive *zip.Reader) ([]Segment, error) {
	numbers := []int{}
	for _, file := range archive.File {
		if number, ok := slideNumber(file.Name); ok {
			numbers = append(numbers, number)
		}
	}
	if len(numbers) == 0 {
		return nil, errors.New("presentation has no slides")
	}
	sort.Ints(numbers)
	segments := make([]Segment, 0, len(numbers))
	total := 0
	for _, number := range numbers {
		payload, err := entry(archive, fmt.Sprintf("ppt/slides/slide%d.xml", number))
		if err != nil {
			return nil, err
		}
		if payload == nil {
			continue
		}
		text, err := textRuns(payload, "t")
		if err != nil {
			return nil, errors.New("presentation XML is invalid")
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		segments = append(segments, Segment{Locator: fmt.Sprintf("slide %d", number), Text: text})
		total += len(text)
		if total > maxArchiveText {
			break
		}
	}
	return segments, nil
}

func slideNumber(name string) (int, bool) {
	if !strings.HasPrefix(name, "ppt/slides/slide") || !strings.HasSuffix(name, ".xml") {
		return 0, false
	}
	digits := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
	number, err := strconv.Atoi(digits)
	if err != nil || number < 1 {
		return 0, false
	}
	return number, true
}

// textRuns concatenates the character data of every element with the given
// local name, one line per element.
func textRuns(payload []byte, local string) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(payload))
	var builder strings.Builder
	inside := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return builder.String(), nil
		}
		if err != nil {
			return "", err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			inside = typed.Name.Local == local
		case xml.CharData:
			if inside {
				builder.Write(typed)
			}
		case xml.EndElement:
			if typed.Name.Local == local && inside {
				builder.WriteByte('\n')
				inside = false
			}
		}
		if builder.Len() > maxEntryBytes {
			return builder.String(), nil
		}
	}
}
