//! Native PDF inspector for Umbratic.
//!
//! Classifies a PDF by sampling content streams (text ops vs image ops), routes
//! pages between native text extraction and vision/OCR, and produces a light
//! Markdown extract plus a route-aware token estimate. The only PDF parsing
//! dependency is `lopdf`.

mod analysis;
pub mod fixtures;
mod tokens;

#[cfg(panic = "abort")]
compile_error!("umbratic-pdf requires panic=unwind to contain parser panics");

use std::fs;
use std::path::Path;

use serde::Serialize;

pub use analysis::{TextQuality, text_quality};
pub use tokens::estimate_text_tokens;

/// Byte cap shared with the desktop attachment pipeline.
pub const DEFAULT_MAX_BYTES: u64 = 25 * 1024 * 1024;
/// Pages classified for routing: the first pages are always covered so the
/// prompt's vision window can be routed per page, later pages are sampled.
pub const DEFAULT_CLASSIFY_PAGE_CAP: usize = 32;
/// Hard cap on pages visited during full extraction.
pub const DEFAULT_EXTRACT_PAGE_CAP: usize = 400;
/// Per-page decompressed content cap (decompression-bomb guard).
pub const DEFAULT_MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Prompt cost of one rasterized PDF page, mirrors CONTEXT_IMAGE_TOKENS.
pub const IMAGE_PAGE_TOKENS: usize = 1600;
/// Rasterized pages are capped at this many in the prompt, mirrors the desktop.
pub const VISION_PAGE_LIMIT: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PdfType {
    TextBased,
    Scanned,
    ImageBased,
    Mixed,
}

#[derive(Debug, Clone)]
pub struct InspectOptions {
    pub max_bytes: u64,
    pub classify_page_cap: usize,
    pub extract: bool,
    pub extract_page_cap: usize,
    /// Cap applied to the Markdown extract and to the text part of the estimate.
    pub token_budget: Option<usize>,
    pub max_stream_bytes: usize,
}

impl Default for InspectOptions {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            classify_page_cap: DEFAULT_CLASSIFY_PAGE_CAP,
            extract: false,
            extract_page_cap: DEFAULT_EXTRACT_PAGE_CAP,
            token_budget: None,
            max_stream_bytes: DEFAULT_MAX_STREAM_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub pdf_type: PdfType,
    pub page_count: usize,
    pub confidence: f64,
    /// 1-indexed pages that need rasterization for vision/OCR.
    pub pages_needing_ocr: Vec<u32>,
    pub has_encoding_issues: bool,
    pub ocr_recommended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    /// Route-aware prompt-cost estimate for the UI meter.
    pub estimated_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectError {
    TooLarge { size: u64, limit: u64 },
    Encrypted,
    NoPages,
    Parse(String),
    Io(String),
}

impl InspectError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooLarge { .. } => "too_large",
            Self::Encrypted => "encrypted",
            Self::NoPages => "no_pages",
            Self::Parse(_) => "parse",
            Self::Io(_) => "io",
        }
    }
}

impl std::fmt::Display for InspectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size, limit } => {
                write!(
                    formatter,
                    "PDF is {size} bytes and exceeds the {limit}-byte cap"
                )
            }
            Self::Encrypted => write!(formatter, "PDF is encrypted"),
            Self::NoPages => write!(formatter, "PDF has no pages"),
            Self::Parse(message) => write!(formatter, "PDF could not be parsed: {message}"),
            Self::Io(message) => write!(formatter, "PDF could not be read: {message}"),
        }
    }
}

impl std::error::Error for InspectError {}

pub fn inspect_file(path: &Path, options: &InspectOptions) -> Result<Inspection, InspectError> {
    let metadata = fs::metadata(path).map_err(|error| InspectError::Io(error.to_string()))?;
    if !metadata.is_file() {
        return Err(InspectError::Io("path is not a file".into()));
    }
    if metadata.len() > options.max_bytes {
        return Err(InspectError::TooLarge {
            size: metadata.len(),
            limit: options.max_bytes,
        });
    }
    let bytes = fs::read(path).map_err(|error| InspectError::Io(error.to_string()))?;
    inspect_bytes(&bytes, options)
}

pub fn inspect_bytes(bytes: &[u8], options: &InspectOptions) -> Result<Inspection, InspectError> {
    if bytes.len() as u64 > options.max_bytes {
        return Err(InspectError::TooLarge {
            size: bytes.len() as u64,
            limit: options.max_bytes,
        });
    }
    // lopdf parses hostile input; a panic must degrade to a parse error instead
    // of taking down the caller (the runner links this library in-process).
    std::panic::catch_unwind(|| analysis::inspect_document(bytes, options))
        .unwrap_or_else(|_| Err(InspectError::Parse("parser panicked".into())))
}
