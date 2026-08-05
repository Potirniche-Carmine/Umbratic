//! Content-stream analysis: one shared walk per page feeds classification,
//! text extraction, encoding-quality checks, and the token estimate.

use std::collections::{BTreeMap, BTreeSet};

use lopdf::{Dictionary, Document, Encoding, Object, ObjectId, content::Content};

use crate::tokens::{estimate_text_tokens, truncate_to_token_budget};
use crate::{
    IMAGE_PAGE_TOKENS, InspectError, InspectOptions, Inspection, PdfType, VISION_PAGE_LIMIT,
};

/// A page with fewer decoded non-whitespace characters than this has no usable
/// text layer.
const MIN_TEXT_CHARS_PER_PAGE: usize = 24;
/// TJ adjustments below this (in thousandths of an em) render as word gaps.
const TJ_SPACE_THRESHOLD: f64 = -120.0;
/// Undecodable show-text operands surface as replacement characters, bounded so
/// a hostile stream cannot balloon the output.
const MAX_REPLACEMENTS_PER_STRING: usize = 80;
/// Form XObjects are walked through at most this many nesting levels.
const MAX_FORM_DEPTH: usize = 2;

pub(crate) fn inspect_document(
    bytes: &[u8],
    options: &InspectOptions,
) -> Result<Inspection, InspectError> {
    let document =
        Document::load_mem(bytes).map_err(|error| InspectError::Parse(error.to_string()))?;
    if document.is_encrypted() {
        return Err(InspectError::Encrypted);
    }
    let pages: Vec<(u32, ObjectId)> = document.get_pages().into_iter().collect();
    let page_count = pages.len();
    if page_count == 0 {
        return Err(InspectError::NoPages);
    }

    let mut analyses: BTreeMap<u32, PageAnalysis> = BTreeMap::new();
    for index in classify_indexes(page_count, options.classify_page_cap) {
        let (page_number, page_id) = pages[index];
        analyses.insert(page_number, analyze_page(&document, page_id, options));
    }

    let classification = classify(&analyses, page_count);
    let combined_text = analyses
        .values()
        .filter(|analysis| analysis.kind() == PageKind::Text)
        .map(|analysis| analysis.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let has_encoding_issues = text_quality(&combined_text).has_issues();
    let ocr_recommended = has_encoding_issues
        || !matches!(classification.pdf_type, PdfType::TextBased)
            && !classification.pages_needing_ocr.is_empty()
        || matches!(
            classification.pdf_type,
            PdfType::Scanned | PdfType::ImageBased
        );

    let markdown = if options.extract {
        Some(build_markdown(&document, &pages, &mut analyses, options))
    } else {
        None
    };

    let estimated_tokens = estimate_tokens(
        &analyses,
        &classification,
        page_count,
        has_encoding_issues,
        markdown.as_deref(),
        options.token_budget,
    );

    Ok(Inspection {
        pdf_type: classification.pdf_type,
        page_count,
        confidence: classification.confidence,
        pages_needing_ocr: classification.pages_needing_ocr,
        has_encoding_issues,
        ocr_recommended,
        markdown,
        estimated_tokens,
    })
}

/// The first pages are always classified (they are what the prompt renders);
/// the remainder is sampled evenly so long documents stay cheap.
fn classify_indexes(page_count: usize, cap: usize) -> Vec<usize> {
    let cap = cap.max(1);
    if page_count <= cap {
        return (0..page_count).collect();
    }
    let leading = cap.div_ceil(2).max(VISION_PAGE_LIMIT.min(cap));
    let mut indexes: Vec<usize> = (0..leading.min(page_count)).collect();
    let sampled = cap.saturating_sub(indexes.len());
    if sampled > 0 {
        let remaining = page_count - indexes.len();
        for step in 0..sampled {
            let offset = remaining * (step + 1) / (sampled + 1);
            indexes.push((indexes.len() + offset).min(page_count - 1));
        }
    }
    indexes.sort_unstable();
    indexes.dedup();
    indexes
}

#[derive(Debug, Default)]
struct PageAnalysis {
    text: String,
    text_chars: usize,
    image_ops: usize,
    paint_ops: usize,
    failed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageKind {
    Text,
    Vision,
    Empty,
}

impl PageAnalysis {
    fn failed() -> Self {
        Self {
            failed: true,
            ..Self::default()
        }
    }

    fn kind(&self) -> PageKind {
        if self.text_chars >= MIN_TEXT_CHARS_PER_PAGE {
            PageKind::Text
        } else if self.failed || self.image_ops > 0 || self.paint_ops > 2 {
            // No text layer but visible content (or an unreadable stream):
            // only rasterization can represent this page.
            PageKind::Vision
        } else {
            PageKind::Empty
        }
    }
}

struct Scope<'a> {
    encodings: BTreeMap<Vec<u8>, Encoding<'a>>,
    images: BTreeSet<Vec<u8>>,
    forms: BTreeMap<Vec<u8>, ObjectId>,
}

fn resolve<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    match object {
        Object::Reference(id) => document.get_object(*id).ok(),
        other => Some(other),
    }
}

fn resolve_dict<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    resolve(document, object).and_then(|value| value.as_dict().ok())
}

fn page_resource_dicts(document: &Document, page_id: ObjectId) -> Vec<&Dictionary> {
    let mut dicts = Vec::new();
    let Ok((direct, inherited)) = document.get_page_resources(page_id) else {
        return dicts;
    };
    if let Some(dict) = direct {
        dicts.push(dict);
    }
    for id in inherited {
        if let Ok(dict) = document.get_object(id).and_then(Object::as_dict) {
            dicts.push(dict);
        }
    }
    dicts
}

fn build_scope<'a>(
    document: &'a Document,
    resource_dicts: &[&'a Dictionary],
    options: &InspectOptions,
) -> Scope<'a> {
    let mut scope = Scope {
        encodings: BTreeMap::new(),
        images: BTreeSet::new(),
        forms: BTreeMap::new(),
    };
    for resources in resource_dicts {
        if let Some(fonts) = resources
            .get(b"Font")
            .ok()
            .and_then(|value| resolve_dict(document, value))
        {
            for (name, value) in fonts.iter() {
                if scope.encodings.contains_key(name) {
                    continue;
                }
                let Some(font) = resolve_dict(document, value) else {
                    continue;
                };
                if let Ok(encoding) =
                    font.get_font_encoding_with_limit(document, options.max_stream_bytes)
                {
                    scope.encodings.insert(name.clone(), encoding);
                }
            }
        }
        if let Some(xobjects) = resources
            .get(b"XObject")
            .ok()
            .and_then(|value| resolve_dict(document, value))
        {
            for (name, value) in xobjects.iter() {
                let subtype = resolve(document, value)
                    .and_then(|object| object.as_stream().ok())
                    .and_then(|stream| stream.dict.get(b"Subtype").ok())
                    .and_then(|object| object.as_name().ok());
                match subtype {
                    Some(b"Image") => {
                        scope.images.insert(name.clone());
                    }
                    Some(b"Form") => {
                        if let Ok(id) = value.as_reference() {
                            scope.forms.insert(name.clone(), id);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    scope
}

#[derive(Debug, Default)]
struct Walk {
    text: String,
    image_ops: usize,
    paint_ops: usize,
    failed: bool,
}

impl Walk {
    fn newline(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with('\n') {
            self.text.push('\n');
        }
    }

    fn space(&mut self) {
        if !self.text.is_empty() && !self.text.ends_with(char::is_whitespace) {
            self.text.push(' ');
        }
    }

    fn push_decoded(&mut self, encoding: Option<&Encoding>, bytes: &[u8]) {
        let start = self.text.len();
        let decoded = match encoding {
            Some(encoding) => encoding.write_to_string(bytes, &mut self.text).is_ok(),
            None => false,
        };
        if !decoded {
            self.text.truncate(start);
            for _ in 0..bytes.len().min(MAX_REPLACEMENTS_PER_STRING) {
                self.text.push('\u{FFFD}');
            }
        }
    }
}

fn number(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(f64::from(*value)),
        _ => None,
    }
}

fn analyze_page(document: &Document, page_id: ObjectId, options: &InspectOptions) -> PageAnalysis {
    let resource_dicts = page_resource_dicts(document, page_id);
    let scope = build_scope(document, &resource_dicts, options);
    let Ok(content_data) = document.get_page_content_with_limit(page_id, options.max_stream_bytes)
    else {
        return PageAnalysis::failed();
    };
    let mut walk = Walk::default();
    walk_content(document, &content_data, &scope, options, &mut walk, 0);
    let text = clean_text(&walk.text);
    PageAnalysis {
        text_chars: text.chars().filter(|value| !value.is_whitespace()).count(),
        text,
        image_ops: walk.image_ops,
        paint_ops: walk.paint_ops,
        failed: walk.failed,
    }
}

fn walk_content(
    document: &Document,
    content_data: &[u8],
    scope: &Scope<'_>,
    options: &InspectOptions,
    walk: &mut Walk,
    depth: usize,
) {
    let Ok(content) = Content::decode(content_data) else {
        walk.failed = true;
        return;
    };
    let mut current_encoding: Option<&Encoding> = None;
    let mut last_text_y: Option<f64> = None;
    for operation in &content.operations {
        match operation.operator.as_ref() {
            "BT" => {
                last_text_y = None;
            }
            "Tf" => {
                current_encoding = operation
                    .operands
                    .first()
                    .and_then(|object| object.as_name().ok())
                    .and_then(|name| scope.encodings.get(name));
            }
            "Tj" => {
                if let Some(Object::String(bytes, _)) = operation.operands.first() {
                    walk.push_decoded(current_encoding, bytes);
                }
            }
            "TJ" => {
                if let Some(Object::Array(items)) = operation.operands.first() {
                    for item in items {
                        match item {
                            Object::String(bytes, _) => walk.push_decoded(current_encoding, bytes),
                            adjustment => {
                                if number(adjustment)
                                    .is_some_and(|value| value <= TJ_SPACE_THRESHOLD)
                                {
                                    walk.space();
                                }
                            }
                        }
                    }
                }
            }
            "'" => {
                walk.newline();
                if let Some(Object::String(bytes, _)) = operation.operands.first() {
                    walk.push_decoded(current_encoding, bytes);
                }
            }
            "\"" => {
                walk.newline();
                if let Some(Object::String(bytes, _)) = operation.operands.get(2) {
                    walk.push_decoded(current_encoding, bytes);
                }
            }
            "Td" | "TD" => {
                let horizontal = operation.operands.first().and_then(number).unwrap_or(0.0);
                let vertical = operation.operands.get(1).and_then(number).unwrap_or(0.0);
                if vertical.abs() > 0.01 {
                    walk.newline();
                } else if horizontal.abs() > 0.01 {
                    walk.space();
                }
            }
            "T*" => walk.newline(),
            "Tm" => {
                let vertical = operation.operands.get(5).and_then(number);
                if let (Some(previous), Some(current)) = (last_text_y, vertical)
                    && (current - previous).abs() > 0.01
                {
                    walk.newline();
                }
                last_text_y = vertical;
            }
            "ET" => walk.newline(),
            "Do" => {
                let Some(name) = operation
                    .operands
                    .first()
                    .and_then(|object| object.as_name().ok())
                else {
                    continue;
                };
                if scope.images.contains(name) {
                    walk.image_ops += 1;
                } else if let Some(form_id) = scope.forms.get(name)
                    && depth < MAX_FORM_DEPTH
                {
                    walk_form(document, *form_id, scope, options, walk, depth + 1);
                }
            }
            "BI" => walk.image_ops += 1,
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "sh" => walk.paint_ops += 1,
            _ => {}
        }
    }
}

fn walk_form(
    document: &Document,
    form_id: ObjectId,
    parent_scope: &Scope<'_>,
    options: &InspectOptions,
    walk: &mut Walk,
    depth: usize,
) {
    let Ok(stream) = document.get_object(form_id).and_then(Object::as_stream) else {
        return;
    };
    let content = stream
        .decompressed_content_with_limit(options.max_stream_bytes)
        .unwrap_or_else(|_| stream.content.clone());
    let own_resources = stream
        .dict
        .get(b"Resources")
        .ok()
        .and_then(|value| resolve_dict(document, value));
    match own_resources {
        Some(resources) => {
            let scope = build_scope(document, &[resources], options);
            walk_content(document, &content, &scope, options, walk, depth);
        }
        None => walk_content(document, &content, parent_scope, options, walk, depth),
    }
}

/// Compacts extracted text: collapses runs of spaces, trims line ends, and
/// bounds consecutive blank lines, so excerpts stay token-efficient.
fn clean_text(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len());
    let mut blank_run = 0usize;
    for line in raw.lines() {
        let mut compact = String::with_capacity(line.len());
        let mut last_was_space = false;
        for character in line.chars() {
            if character.is_whitespace() {
                if !last_was_space && !compact.is_empty() {
                    compact.push(' ');
                }
                last_was_space = true;
            } else {
                compact.push(character);
                last_was_space = false;
            }
        }
        let compact = compact.trim_end();
        if compact.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !cleaned.is_empty() {
            cleaned.push('\n');
        }
        cleaned.push_str(compact);
    }
    cleaned.trim().to_owned()
}

#[derive(Debug)]
struct Classification {
    pdf_type: PdfType,
    confidence: f64,
    pages_needing_ocr: Vec<u32>,
}

fn classify(analyses: &BTreeMap<u32, PageAnalysis>, page_count: usize) -> Classification {
    let mut text_pages = 0usize;
    let mut vision_pages = 0usize;
    let mut empty_pages = 0usize;
    let mut vision_image_ops = 0usize;
    let mut pages_needing_ocr = Vec::new();
    for (page_number, analysis) in analyses {
        match analysis.kind() {
            PageKind::Text => text_pages += 1,
            PageKind::Vision => {
                vision_pages += 1;
                vision_image_ops += analysis.image_ops;
                pages_needing_ocr.push(*page_number);
            }
            PageKind::Empty => empty_pages += 1,
        }
    }
    let classified = analyses.len().max(1);
    let sampled_penalty = if analyses.len() < page_count {
        0.9
    } else {
        1.0
    };
    let (pdf_type, agreement) = if text_pages == 0 && vision_pages == 0 {
        // Nothing recognizable on any sampled page: fail toward vision with an
        // explicitly low confidence so callers fall back to rendering.
        (PdfType::ImageBased, 0.2)
    } else if vision_pages == 0 {
        (
            PdfType::TextBased,
            text_pages as f64 / (text_pages + empty_pages) as f64,
        )
    } else if text_pages == 0 {
        // One raster image per page reads as a scan; heavier image or
        // vector-only composition reads as an image/graphics document.
        let average_images = vision_image_ops as f64 / vision_pages as f64;
        let pdf_type = if (0.99..=2.0).contains(&average_images) {
            PdfType::Scanned
        } else {
            PdfType::ImageBased
        };
        (
            pdf_type,
            vision_pages as f64 / (vision_pages + empty_pages) as f64,
        )
    } else {
        (
            PdfType::Mixed,
            (text_pages + vision_pages) as f64 / classified as f64,
        )
    };
    Classification {
        pdf_type,
        confidence: ((agreement * sampled_penalty).clamp(0.05, 0.99) * 100.0).round() / 100.0,
        pages_needing_ocr,
    }
}

/// Quality heuristics over extracted text, used to detect garbled CID or
/// ToUnicode output that should fall back to vision/OCR.
#[derive(Debug, Clone, Copy)]
pub struct TextQuality {
    pub total_chars: usize,
    pub replacement_ratio: f64,
    pub readable_ratio: f64,
    pub space_ratio: f64,
    pub dollar_ratio: f64,
}

impl TextQuality {
    pub fn has_issues(&self) -> bool {
        if self.total_chars < 40 {
            return false;
        }
        if self.replacement_ratio > 0.03 {
            return true;
        }
        if self.readable_ratio < 0.5 {
            return true;
        }
        // Some broken encodings map the space glyph to '$' (or similar),
        // yielding dollar-dense, space-free text.
        self.space_ratio < 0.01 && self.dollar_ratio > 0.02
    }
}

pub fn text_quality(text: &str) -> TextQuality {
    let mut total_chars = 0usize;
    let mut replacements = 0usize;
    let mut readable = 0usize;
    let mut spaces = 0usize;
    let mut dollars = 0usize;
    for character in text.chars() {
        total_chars += 1;
        match character {
            '\u{FFFD}' => replacements += 1,
            '$' => dollars += 1,
            _ if character.is_whitespace() => {
                spaces += 1;
                readable += 1;
            }
            _ if character.is_alphanumeric() => readable += 1,
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '(' | ')' | '-' | '–' | '—' | '/'
            | '%' | '&' | '@' | '#' | '*' | '+' | '=' | '[' | ']' | '<' | '>' => {
                readable += 1;
            }
            _ => {}
        }
    }
    let total = total_chars.max(1) as f64;
    TextQuality {
        total_chars,
        replacement_ratio: replacements as f64 / total,
        readable_ratio: readable as f64 / total,
        space_ratio: spaces as f64 / total,
        dollar_ratio: dollars as f64 / total,
    }
}

fn build_markdown(
    document: &Document,
    pages: &[(u32, ObjectId)],
    analyses: &mut BTreeMap<u32, PageAnalysis>,
    options: &InspectOptions,
) -> String {
    let mut sections: Vec<String> = Vec::new();
    let mut used_tokens = 0usize;
    let budget = options.token_budget.unwrap_or(usize::MAX);
    let mut truncated = false;
    let visited = pages.len().min(options.extract_page_cap);
    for (page_number, page_id) in pages.iter().take(visited) {
        if used_tokens >= budget {
            truncated = true;
            break;
        }
        if !analyses.contains_key(page_number) {
            let analysis = analyze_page(document, *page_id, options);
            analyses.insert(*page_number, analysis);
        }
        let analysis = &analyses[page_number];
        let body = match analysis.kind() {
            PageKind::Text => analysis.text.clone(),
            PageKind::Vision => {
                "(no machine-readable text on this page; it needs vision or OCR)".to_owned()
            }
            PageKind::Empty => "(blank page)".to_owned(),
        };
        let section = format!("--- Page {page_number} ---\n\n{body}");
        let section_tokens = estimate_text_tokens(&section);
        if used_tokens + section_tokens > budget {
            let (cut, _) = truncate_to_token_budget(&section, budget - used_tokens);
            if !cut.is_empty() {
                sections.push(cut);
            }
            truncated = true;
            break;
        }
        used_tokens += section_tokens;
        sections.push(section);
    }
    let mut markdown = sections.join("\n\n");
    if visited < pages.len() && !truncated {
        truncated = true;
    }
    if truncated {
        markdown.push_str("\n\n...[extract truncated; the rest of the document was not inlined]");
    }
    markdown
}

fn estimate_tokens(
    analyses: &BTreeMap<u32, PageAnalysis>,
    classification: &Classification,
    page_count: usize,
    has_encoding_issues: bool,
    markdown: Option<&str>,
    token_budget: Option<usize>,
) -> usize {
    let budget = token_budget.unwrap_or(usize::MAX);
    let vision_estimate = page_count.min(VISION_PAGE_LIMIT) * IMAGE_PAGE_TOKENS;
    if has_encoding_issues
        || matches!(
            classification.pdf_type,
            PdfType::Scanned | PdfType::ImageBased
        )
    {
        return vision_estimate;
    }
    let text_tokens = match markdown {
        // A produced extract is the exact text payload; prefer it.
        Some(markdown) => estimate_text_tokens(markdown),
        None => projected_text_tokens(analyses, page_count),
    }
    .min(budget);
    match classification.pdf_type {
        PdfType::TextBased => text_tokens,
        PdfType::Mixed => {
            let ocr_prompt_pages = classification
                .pages_needing_ocr
                .iter()
                .filter(|page| **page <= VISION_PAGE_LIMIT as u32)
                .count();
            text_tokens + ocr_prompt_pages * IMAGE_PAGE_TOKENS
        }
        PdfType::Scanned | PdfType::ImageBased => vision_estimate,
    }
}

/// Detect-only mode has text for the classified pages; extrapolate the rest of
/// the document from the average text page.
fn projected_text_tokens(analyses: &BTreeMap<u32, PageAnalysis>, page_count: usize) -> usize {
    let text_pages: Vec<&PageAnalysis> = analyses
        .values()
        .filter(|analysis| analysis.kind() == PageKind::Text)
        .collect();
    if text_pages.is_empty() {
        return 0;
    }
    let sampled_tokens: usize = text_pages
        .iter()
        .map(|analysis| estimate_text_tokens(&analysis.text))
        .sum();
    let classified = analyses.len().max(1);
    let text_fraction = text_pages.len() as f64 / classified as f64;
    let projected_text_pages = (page_count as f64 * text_fraction).round().max(1.0);
    let average = sampled_tokens as f64 / text_pages.len() as f64;
    (average * projected_text_pages).round() as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{FixturePage, build_pdf, tj_offsets_pdf, undecodable_text_pdf};
    use crate::{InspectOptions, inspect_bytes};

    const PARAGRAPH: &str = "Umbratic routes PDF attachments natively.\nText pages skip rasterization entirely,\nwhich frees prompt tokens for real work.";

    fn full_options() -> InspectOptions {
        InspectOptions {
            extract: true,
            ..InspectOptions::default()
        }
    }

    #[test]
    fn text_pdf_classifies_as_text_based_and_extracts_markdown() {
        let bytes = build_pdf(&[FixturePage::Text(PARAGRAPH), FixturePage::Text(PARAGRAPH)]);
        let inspection = inspect_bytes(&bytes, &full_options()).expect("inspects");
        assert_eq!(inspection.pdf_type, PdfType::TextBased);
        assert_eq!(inspection.page_count, 2);
        assert!(
            inspection.confidence >= 0.7,
            "confidence {}",
            inspection.confidence
        );
        assert!(inspection.pages_needing_ocr.is_empty());
        assert!(!inspection.has_encoding_issues);
        assert!(!inspection.ocr_recommended);
        let markdown = inspection.markdown.as_deref().expect("markdown");
        assert!(markdown.contains("Umbratic routes PDF attachments natively."));
        assert!(markdown.contains("--- Page 2 ---"));
        assert_eq!(inspection.estimated_tokens, estimate_text_tokens(markdown));
        assert!(inspection.estimated_tokens < IMAGE_PAGE_TOKENS);
    }

    #[test]
    fn scanned_pdf_routes_every_page_to_ocr() {
        let bytes = build_pdf(&[FixturePage::Images(1), FixturePage::Images(1)]);
        let inspection = inspect_bytes(&bytes, &full_options()).expect("inspects");
        assert_eq!(inspection.pdf_type, PdfType::Scanned);
        assert_eq!(inspection.pages_needing_ocr, vec![1, 2]);
        assert!(inspection.ocr_recommended);
        assert_eq!(inspection.estimated_tokens, 2 * IMAGE_PAGE_TOKENS);
        let markdown = inspection.markdown.as_deref().expect("markdown");
        assert!(markdown.contains("no machine-readable text"));
    }

    #[test]
    fn image_heavy_pdf_is_image_based() {
        let bytes = build_pdf(&[FixturePage::Images(4), FixturePage::Images(5)]);
        let inspection = inspect_bytes(&bytes, &InspectOptions::default()).expect("inspects");
        assert_eq!(inspection.pdf_type, PdfType::ImageBased);
        assert!(inspection.ocr_recommended);
    }

    #[test]
    fn mixed_pdf_reports_only_image_pages_for_ocr() {
        let bytes = build_pdf(&[
            FixturePage::Text(PARAGRAPH),
            FixturePage::Images(1),
            FixturePage::Text(PARAGRAPH),
        ]);
        let inspection = inspect_bytes(&bytes, &full_options()).expect("inspects");
        assert_eq!(inspection.pdf_type, PdfType::Mixed);
        assert_eq!(inspection.pages_needing_ocr, vec![2]);
        assert!(inspection.ocr_recommended);
        let markdown = inspection.markdown.as_deref().expect("markdown");
        assert!(markdown.contains("--- Page 3 ---"));
        assert!(inspection.estimated_tokens >= IMAGE_PAGE_TOKENS);
        assert!(inspection.estimated_tokens < 2 * IMAGE_PAGE_TOKENS);
    }

    #[test]
    fn empty_pages_classify_without_ocr() {
        let bytes = build_pdf(&[FixturePage::Empty, FixturePage::Empty]);
        let inspection = inspect_bytes(&bytes, &InspectOptions::default()).expect("inspects");
        assert!(inspection.pages_needing_ocr.is_empty());
        assert!(inspection.confidence <= 0.3);
    }

    #[test]
    fn tj_kerning_offsets_become_word_gaps() {
        let inspection = inspect_bytes(&tj_offsets_pdf(), &full_options()).expect("inspects");
        let markdown = inspection.markdown.as_deref().expect("markdown");
        // -250 crosses the word-gap threshold and becomes a space; -30 is
        // kerning inside a word and must not.
        assert!(
            markdown.contains("Umbratic nativeinspector classification pipeline"),
            "markdown: {markdown}"
        );
    }

    #[test]
    fn undecodable_text_flags_encoding_issues() {
        let inspection =
            inspect_bytes(&undecodable_text_pdf(), &InspectOptions::default()).expect("inspects");
        assert!(inspection.has_encoding_issues);
        assert!(inspection.ocr_recommended);
        assert_eq!(inspection.estimated_tokens, IMAGE_PAGE_TOKENS);
    }

    #[test]
    fn detect_mode_omits_markdown_but_estimates_text() {
        let bytes = build_pdf(&[FixturePage::Text(PARAGRAPH)]);
        let inspection = inspect_bytes(&bytes, &InspectOptions::default()).expect("inspects");
        assert!(inspection.markdown.is_none());
        assert!(inspection.estimated_tokens > 0);
        assert!(inspection.estimated_tokens < IMAGE_PAGE_TOKENS);
    }

    #[test]
    fn token_budget_truncates_markdown() {
        let long = PARAGRAPH.repeat(40);
        let bytes = build_pdf(&[FixturePage::Text(&long), FixturePage::Text(&long)]);
        let options = InspectOptions {
            extract: true,
            token_budget: Some(64),
            ..InspectOptions::default()
        };
        let inspection = inspect_bytes(&bytes, &options).expect("inspects");
        let markdown = inspection.markdown.as_deref().expect("markdown");
        assert!(markdown.contains("extract truncated"));
        assert!(
            inspection.estimated_tokens
                <= 64
                    + estimate_text_tokens(
                        "\n\n...[extract truncated; the rest of the document was not inlined]"
                    )
        );
    }

    #[test]
    fn junk_bytes_fail_with_parse_error() {
        let error = inspect_bytes(b"not a pdf at all", &InspectOptions::default()).unwrap_err();
        assert_eq!(error.code(), "parse");
    }

    #[test]
    fn oversize_input_fails_closed() {
        let bytes = build_pdf(&[FixturePage::Text(PARAGRAPH)]);
        let options = InspectOptions {
            max_bytes: 16,
            ..InspectOptions::default()
        };
        assert_eq!(
            inspect_bytes(&bytes, &options).unwrap_err().code(),
            "too_large"
        );
    }

    #[test]
    fn quality_heuristics_flag_garbled_text() {
        assert!(
            !text_quality("A perfectly ordinary paragraph of readable text, long enough to judge.")
                .has_issues()
        );
        let replacements = "\u{FFFD}".repeat(30) + "short tail of text";
        assert!(text_quality(&replacements).has_issues());
        let dollars = "word$word$word$word$word$word$word$word$word$word$word$word".repeat(2);
        assert!(text_quality(&dollars).has_issues());
        assert!(!text_quality("tiny").has_issues());
    }

    #[test]
    fn classify_indexes_cover_leading_pages_and_sample_the_tail() {
        let indexes = classify_indexes(200, 32);
        assert!(indexes.len() <= 32);
        assert!(indexes.contains(&0));
        assert!(
            indexes.contains(&11),
            "first 12 pages must be covered: {indexes:?}"
        );
        assert!(indexes.iter().any(|index| *index > 100));
        assert_eq!(classify_indexes(3, 32), vec![0, 1, 2]);
    }
}
