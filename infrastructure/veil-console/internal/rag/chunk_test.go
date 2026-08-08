package rag

import (
	"strings"
	"testing"

	"umbratic-veil-console/internal/extract"
)

func TestChunksCarryTheirSectionAndStayBounded(t *testing.T) {
	paragraph := strings.Repeat("Refund terms apply to every plan. ", 40) // ~1.3 KB
	segments := []extract.Segment{
		{Locator: "Refunds", Text: paragraph + "\n\n" + paragraph + "\n\n" + paragraph},
		{Locator: "page 2", Text: "Short section."},
	}
	chunks := Chunks(segments)
	if len(chunks) < 3 {
		t.Fatalf("expected the long segment to split, got %d chunks", len(chunks))
	}
	for index, chunk := range chunks {
		if chunk.Index != index {
			t.Fatalf("chunk %d reports index %d", index, chunk.Index)
		}
		if len(chunk.Text) > maxChunkBytes+overlapBytes {
			t.Fatalf("chunk %d is %d bytes, over the cap", index, len(chunk.Text))
		}
	}
	if chunks[len(chunks)-1].Section != "page 2" {
		t.Fatalf("last chunk lost its locator: %+v", chunks[len(chunks)-1])
	}
	for _, chunk := range chunks[:len(chunks)-1] {
		if chunk.Section != "Refunds" {
			t.Fatalf("chunk lost its section: %+v", chunk)
		}
	}
}

// A sentence that lands on a chunk boundary must still be retrievable, which is
// what the overlap buys.
func TestConsecutiveChunksOverlap(t *testing.T) {
	body := strings.Repeat("alpha beta gamma delta. ", 200)
	chunks := Chunks([]extract.Segment{{Locator: "s", Text: body}})
	if len(chunks) < 2 {
		t.Fatalf("expected several chunks, got %d", len(chunks))
	}
	tail := chunks[0].Text[max(0, len(chunks[0].Text)-overlapBytes):]
	if !strings.Contains(tail, chunks[1].Text[:32]) {
		t.Fatalf("second chunk does not start inside the first chunk's tail:\ntail=%q\nnext=%q",
			tail, chunks[1].Text[:40])
	}
}

// A blob with no paragraph breaks at all still has to be split, and the cut
// should land between words when one is available.
func TestUnbrokenTextIsStillSplit(t *testing.T) {
	chunks := Chunks([]extract.Segment{{Locator: "", Text: strings.Repeat("x", 10_000)}})
	if len(chunks) < 4 {
		t.Fatalf("unbroken text was not split: %d chunks", len(chunks))
	}
	words := strings.Repeat("word ", 2000)
	wordChunks := Chunks([]extract.Segment{{Locator: "", Text: words}})
	for _, chunk := range wordChunks {
		if strings.HasPrefix(chunk.Text, "ord") || strings.HasSuffix(chunk.Text, "wor") {
			t.Fatalf("a cut landed mid-word: %q", chunk.Text[:10])
		}
	}
}

func TestEmptyInputProducesNoChunks(t *testing.T) {
	if chunks := Chunks(nil); len(chunks) != 0 {
		t.Fatalf("nil segments produced %d chunks", len(chunks))
	}
	if chunks := Chunks([]extract.Segment{{Locator: "s", Text: "   \n\n  "}}); len(chunks) != 0 {
		t.Fatalf("blank text produced %d chunks", len(chunks))
	}
}

func TestEmbeddingsEndpointResolution(t *testing.T) {
	for base, want := range map[string]string{
		"http://127.0.0.1:8001":               "http://127.0.0.1:8001/v1/embeddings",
		"http://127.0.0.1:8001/v1":            "http://127.0.0.1:8001/v1/embeddings",
		"http://127.0.0.1:8001/v1/":           "http://127.0.0.1:8001/v1/embeddings",
		"http://127.0.0.1:8001/v1/embeddings": "http://127.0.0.1:8001/v1/embeddings",
	} {
		got, err := embeddingsEndpoint(base)
		if err != nil || got != want {
			t.Errorf("embeddingsEndpoint(%q) = %q, %v; want %q", base, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://127.0.0.1", "not a url", "//host/v1"} {
		if _, err := embeddingsEndpoint(bad); err == nil {
			t.Errorf("embeddingsEndpoint(%q) was accepted", bad)
		}
	}
}
