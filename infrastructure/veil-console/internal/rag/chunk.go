// Package rag owns the corpus side of retrieval: chunking extracted text,
// embedding it through the configured runtime, and keeping the Qdrant
// collection in step with what the administrator uploaded.
package rag

import (
	"strings"

	"umbratic-veil-console/internal/extract"
)

// Chunks are sized for retrieval, not for display: large enough to carry an
// idea, small enough that six of them fit an injection budget. The overlap
// keeps a sentence that straddles a boundary retrievable from either side.
const (
	targetChunkBytes = 1800
	overlapBytes     = 200
	maxChunkBytes    = 2400
)

type Chunk struct {
	Index   int
	Section string
	Text    string
}

// Chunks splits located segments on paragraph boundaries where it can and on
// size where it must. Section locators are carried through so every chunk can
// cite where it came from.
func Chunks(segments []extract.Segment) []Chunk {
	chunks := []Chunk{}
	for _, segment := range segments {
		for _, text := range splitSegment(segment.Text) {
			chunks = append(chunks, Chunk{Index: len(chunks), Section: segment.Locator, Text: text})
		}
	}
	return chunks
}

func splitSegment(text string) []string {
	paragraphs := paragraphsOf(text)
	pieces := []string{}
	var current strings.Builder
	flush := func() {
		if strings.TrimSpace(current.String()) != "" {
			pieces = append(pieces, strings.TrimSpace(current.String()))
		}
		current.Reset()
	}
	for _, paragraph := range paragraphs {
		for _, part := range hardSplit(paragraph) {
			if current.Len() > 0 && current.Len()+len(part) > targetChunkBytes {
				tail := overlapOf(current.String())
				flush()
				current.WriteString(tail)
			}
			if current.Len() > 0 {
				current.WriteString("\n\n")
			}
			current.WriteString(part)
		}
	}
	flush()
	return pieces
}

func paragraphsOf(text string) []string {
	parts := strings.Split(text, "\n\n")
	paragraphs := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			paragraphs = append(paragraphs, trimmed)
		}
	}
	return paragraphs
}

// hardSplit is the fallback for a paragraph with no internal boundary at all —
// a minified blob or a single enormous line. It cuts on the last line break or
// space before the cap so a cut lands between words when one is available.
func hardSplit(paragraph string) []string {
	if len(paragraph) <= maxChunkBytes {
		return []string{paragraph}
	}
	parts := []string{}
	for len(paragraph) > maxChunkBytes {
		cut := targetChunkBytes
		if index := strings.LastIndexAny(paragraph[:cut], "\n "); index > targetChunkBytes/2 {
			cut = index
		}
		for cut > 0 && !isRuneStart(paragraph[cut]) {
			cut--
		}
		if cut == 0 {
			break
		}
		parts = append(parts, strings.TrimSpace(paragraph[:cut]))
		paragraph = strings.TrimSpace(paragraph[cut:])
	}
	if strings.TrimSpace(paragraph) != "" {
		parts = append(parts, paragraph)
	}
	return parts
}

// overlapOf returns the tail of a chunk that the next chunk repeats, trimmed
// back to a word boundary.
func overlapOf(text string) string {
	if len(text) <= overlapBytes {
		return text
	}
	tail := text[len(text)-overlapBytes:]
	if index := strings.IndexAny(tail, "\n "); index >= 0 && index < len(tail)-1 {
		tail = tail[index+1:]
	}
	for index := 0; index < len(tail); index++ {
		if isRuneStart(tail[index]) {
			return tail[index:]
		}
	}
	return ""
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }
