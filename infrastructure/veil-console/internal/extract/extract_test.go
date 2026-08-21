package extract

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

// The name a browser sends is attacker-controlled, so it may pick between two
// byte-identical text types and nothing else. Whether a file is parsed as an
// archive or a PDF is decided by its bytes.
func TestKindComesFromBytesNotTheName(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		data    []byte
		file    string
		want    string
		wantErr bool
	}{
		{name: "pdf magic", data: []byte("%PDF-1.7\n..."), file: "notes.md", want: KindPDF},
		{name: "markdown by name", data: []byte("# Title\n"), file: "notes.md", want: KindMarkdown},
		{name: "text by name", data: []byte("# Title\n"), file: "notes.txt", want: KindText},
		{name: "text without extension", data: []byte("plain"), file: "notes", want: KindText},
		{name: "binary", data: []byte{0x00, 0x01, 0x02, 0xff}, file: "x.md", wantErr: true},
		{name: "empty", data: nil, file: "x.md", wantErr: true},
		{name: "oversized", data: bytes.Repeat([]byte("a"), MaxFileBytes+1), file: "x.md", wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			kind, err := Kind(testCase.data, testCase.file)
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("expected a rejection, got kind %q", kind)
				}
				return
			}
			if err != nil || kind != testCase.want {
				t.Fatalf("Kind = %q, %v; want %q", kind, err, testCase.want)
			}
		})
	}
}

func TestOfficeKindsAreDetectedByTheirParts(t *testing.T) {
	for kind, part := range map[string]string{
		KindDOCX: "word/document.xml",
		KindPPTX: "ppt/slides/slide1.xml",
		KindXLSX: "xl/workbook.xml",
	} {
		archive := buildZip(t, map[string]string{part: "<a/>"})
		got, err := Kind(archive, "upload.bin")
		if err != nil || got != kind {
			t.Errorf("Kind for %s = %q, %v; want %q", part, got, err, kind)
		}
	}
	if _, err := Kind(buildZip(t, map[string]string{"random.txt": "hi"}), "x.zip"); err == nil {
		t.Fatal("an unrelated archive was accepted")
	}
}

func TestMarkdownSegmentsCarryTheirHeading(t *testing.T) {
	body := "# Handbook\n\nIntro text.\n\n## Refunds\n\nRefunds take 14 days.\n"
	segments, err := Segments(context.Background(), Options{Kind: KindMarkdown, Data: []byte(body)})
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 2 {
		t.Fatalf("expected 2 located segments, got %d: %+v", len(segments), segments)
	}
	if segments[1].Locator != "Refunds" || !strings.Contains(segments[1].Text, "14 days") {
		t.Fatalf("heading locator wrong: %+v", segments[1])
	}
}

func TestOfficeSegmentsAndLocators(t *testing.T) {
	docx := buildZip(t, map[string]string{"word/document.xml": `<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Policy</w:t></w:r></w:p>
<w:p><w:r><w:t>Two reviewers are required.</w:t></w:r></w:p></w:body></w:document>`})
	segments, err := Segments(context.Background(), Options{Kind: KindDOCX, Data: docx})
	if err != nil || len(segments) != 1 || segments[0].Locator != "Policy" {
		t.Fatalf("docx segments wrong: %+v %v", segments, err)
	}

	pptx := buildZip(t, map[string]string{"ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><a:t>Launch plan</a:t></p:sld>`})
	segments, err = Segments(context.Background(), Options{Kind: KindPPTX, Data: pptx})
	if err != nil || len(segments) != 1 || segments[0].Locator != "slide 1" {
		t.Fatalf("pptx segments wrong: %+v %v", segments, err)
	}

	xlsx := buildZip(t, map[string]string{
		"xl/workbook.xml":      `<workbook><sheets><sheet name="Quotas" sheetId="1"/></sheets></workbook>`,
		"xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><t>EMEA</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
	})
	segments, err = Segments(context.Background(), Options{Kind: KindXLSX, Data: xlsx})
	if err != nil || len(segments) != 1 {
		t.Fatalf("xlsx segments wrong: %+v %v", segments, err)
	}
	if segments[0].Locator != "Quotas rows 1-2" || !strings.Contains(segments[0].Text, "EMEA") {
		t.Fatalf("xlsx locator or text wrong: %+v", segments[0])
	}
}

// Extracted text reaches a prompt, so control characters never survive it.
func TestExtractedTextIsCleaned(t *testing.T) {
	segments, err := Segments(context.Background(), Options{
		Kind: KindText, Data: []byte("line one\x07\x00\r\nline two"),
	})
	if err != nil {
		t.Fatal(err)
	}
	text := segments[0].Text
	if strings.ContainsAny(text, "\x00\x07\r") {
		t.Fatalf("control characters survived: %q", text)
	}
	if !strings.Contains(text, "line one") || !strings.Contains(text, "line two") {
		t.Fatalf("cleaning dropped content: %q", text)
	}
}

func TestArchiveEntryCountIsBounded(t *testing.T) {
	entries := map[string]string{"word/document.xml": "<a/>"}
	for index := 0; index < maxArchiveEntries+1; index++ {
		entries[fmt.Sprintf("pad/%d.bin", index)] = "."
	}
	if len(entries) <= maxArchiveEntries {
		t.Fatalf("fixture has %d unique entries, need more than %d", len(entries), maxArchiveEntries)
	}
	archive := buildZip(t, entries)
	_, err := Kind(archive, "big.docx")
	if err == nil {
		t.Fatal("an archive over the entry cap was accepted")
	}
	if !strings.Contains(err.Error(), "too many parts") {
		t.Fatalf("wrong rejection: %v", err)
	}
}

func TestArchiveEntryBytesAreBounded(t *testing.T) {
	oversized := strings.Repeat("a", maxEntryBytes+1)
	archive := buildZip(t, map[string]string{"word/document.xml": oversized})
	_, err := Segments(context.Background(), Options{Kind: KindDOCX, Data: archive})
	if err == nil {
		t.Fatal("an oversized Office part was extracted")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("wrong rejection: %v", err)
	}
}

func TestSegmentsRejectUnsupportedKind(t *testing.T) {
	if _, err := Segments(context.Background(), Options{Kind: "exe", Data: []byte("x")}); err == nil {
		t.Fatal("an unsupported kind was extracted")
	}
	if _, err := Segments(context.Background(), Options{Kind: KindPDF, Data: []byte("%PDF-")}); err == nil {
		t.Fatal("a PDF was extracted with no extractor configured")
	}
}

func buildZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, body := range entries {
		part, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
