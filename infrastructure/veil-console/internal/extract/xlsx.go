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

// xlsxSegments reads shared strings once, then each worksheet in workbook
// order, emitting a segment per row band so a citation can name a sheet and a
// row range rather than the whole file.
func xlsxSegments(archive *zip.Reader) ([]Segment, error) {
	shared, err := sharedStrings(archive)
	if err != nil {
		return nil, err
	}
	names := sheetNames(archive)
	sheets := worksheetNames(archive)
	if len(sheets) == 0 {
		return nil, errors.New("workbook has no sheets")
	}
	segments := []Segment{}
	total := 0
	for index, sheet := range sheets {
		payload, err := entry(archive, sheet)
		if err != nil {
			return nil, err
		}
		if payload == nil {
			continue
		}
		title := fmt.Sprintf("Sheet %d", index+1)
		if index < len(names) && strings.TrimSpace(names[index]) != "" {
			title = names[index]
		}
		rows, err := sheetRows(payload, shared)
		if err != nil {
			return nil, errors.New("workbook XML is invalid")
		}
		for start := 0; start < len(rows); start += xlsxRowsPerSegment {
			end := min(start+xlsxRowsPerSegment, len(rows))
			text := strings.Join(rows[start:end], "\n")
			if strings.TrimSpace(text) == "" {
				continue
			}
			segments = append(segments, Segment{
				Locator: fmt.Sprintf("%s rows %d-%d", title, start+1, end),
				Text:    text,
			})
			total += len(text)
			if total > maxArchiveText {
				return segments, nil
			}
		}
	}
	return segments, nil
}

func sharedStrings(archive *zip.Reader) ([]string, error) {
	payload, err := entry(archive, "xl/sharedStrings.xml")
	if err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, nil
	}
	decoder := xml.NewDecoder(bytes.NewReader(payload))
	strs := []string{}
	var current strings.Builder
	depth := 0
	inText := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return strs, nil
		}
		if err != nil {
			return nil, errors.New("workbook shared strings are invalid")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "si":
				depth, current = 1, strings.Builder{}
			case "t":
				inText = depth > 0
			}
		case xml.CharData:
			if inText {
				current.Write(typed)
			}
		case xml.EndElement:
			switch typed.Name.Local {
			case "t":
				inText = false
			case "si":
				depth = 0
				strs = append(strs, current.String())
				if len(strs) > 1<<20 {
					return strs, nil
				}
			}
		}
	}
}

// sheetNames reads the workbook's declared sheet order. Sheet parts are matched
// by position, which is the order Excel writes them in; a mismatch only costs a
// less precise locator, never wrong text.
func sheetNames(archive *zip.Reader) []string {
	payload, err := entry(archive, "xl/workbook.xml")
	if err != nil || payload == nil {
		return nil
	}
	decoder := xml.NewDecoder(bytes.NewReader(payload))
	names := []string{}
	for {
		token, err := decoder.Token()
		if err != nil {
			return names
		}
		if element, ok := token.(xml.StartElement); ok && element.Name.Local == "sheet" {
			names = append(names, attribute(element, "name"))
		}
		if len(names) > maxArchiveEntries {
			return names
		}
	}
}

func worksheetNames(archive *zip.Reader) []string {
	sheets := []string{}
	for _, file := range archive.File {
		if strings.HasPrefix(file.Name, "xl/worksheets/sheet") && strings.HasSuffix(file.Name, ".xml") {
			sheets = append(sheets, file.Name)
		}
	}
	sort.Slice(sheets, func(a, b int) bool {
		return worksheetIndex(sheets[a]) < worksheetIndex(sheets[b])
	})
	return sheets
}

func worksheetIndex(name string) int {
	digits := strings.TrimSuffix(strings.TrimPrefix(name, "xl/worksheets/sheet"), ".xml")
	number, err := strconv.Atoi(digits)
	if err != nil {
		return 1 << 30
	}
	return number
}

// sheetRows renders each row as tab-separated cell values, resolving shared
// string references and inline strings.
func sheetRows(payload []byte, shared []string) ([]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(payload))
	rows := []string{}
	cells := []string{}
	var value strings.Builder
	sharedRef := false
	inValue := false
	inRow := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rows, nil
		}
		if err != nil {
			return nil, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "row":
				inRow, cells = true, cells[:0]
			case "c":
				sharedRef, value = attribute(typed, "t") == "s", strings.Builder{}
			case "v", "t":
				inValue = inRow
			}
		case xml.CharData:
			if inValue {
				value.Write(typed)
			}
		case xml.EndElement:
			switch typed.Name.Local {
			case "v", "t":
				inValue = false
			case "c":
				cells = append(cells, cellValue(value.String(), sharedRef, shared))
			case "row":
				inRow = false
				line := strings.TrimSpace(strings.Join(cells, "\t"))
				if line != "" {
					rows = append(rows, line)
				}
				if len(rows) > 1<<18 {
					return rows, nil
				}
			}
		}
	}
}

func cellValue(raw string, sharedRef bool, shared []string) string {
	if !sharedRef {
		return raw
	}
	index, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || index < 0 || index >= len(shared) {
		return ""
	}
	return shared[index]
}
