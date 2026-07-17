use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use sha2::{Digest, Sha256};

const MIN_COMPRESS_BYTES: usize = 16 * 1024;
const MAX_DISPLAYED_BYTES: usize = 12 * 1024;
const MAX_STORED_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 32;
const RETRIEVAL_DEFAULT_BYTES: usize = 12 * 1024;
const RETRIEVAL_MAX_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone)]
pub struct StoredContextEntry {
    pub hash: String,
    pub full_hash: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub title: String,
    pub original: String,
    pub compressed: String,
    pub kind: String,
    pub strategy: String,
    pub original_bytes: usize,
    pub stored_bytes: usize,
    pub compressed_bytes: usize,
    pub original_truncated: bool,
    pub retrieval_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedContextWindow {
    #[serde(skip)]
    pub entry: StoredContextEntry,
    pub offset: usize,
    pub bytes_shown: usize,
    pub total_bytes: usize,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

#[derive(Debug, Default)]
pub struct SessionContextStore {
    entries: HashMap<String, StoredContextEntry>,
    order: VecDeque<String>,
}

pub fn context_hash(value: &str) -> (String, String) {
    let full = format!("{:x}", Sha256::digest(value.as_bytes()));
    (full[..24].to_owned(), full)
}

fn clip_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1
    }
    value[..end].to_owned()
}

impl SessionContextStore {
    #[allow(clippy::too_many_arguments)]
    pub fn store(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        title: &str,
        original: &str,
        compressed: &str,
        kind: &str,
        strategy: &str,
    ) -> Result<StoredContextEntry, String> {
        let (hash, full_hash) = context_hash(original);
        if self
            .entries
            .get(&hash)
            .is_some_and(|entry| entry.full_hash != full_hash)
        {
            return Err(format!("Context hash collision for {hash}"));
        }
        let stored = clip_utf8(original, MAX_STORED_BYTES);
        let retrieval_count = self
            .entries
            .get(&hash)
            .map(|entry| entry.retrieval_count)
            .unwrap_or(0);
        let entry = StoredContextEntry {
            hash: hash.clone(),
            full_hash,
            tool_call_id: tool_call_id.to_owned(),
            tool_name: tool_name.to_owned(),
            title: title.to_owned(),
            original: stored.clone(),
            compressed: compressed.to_owned(),
            kind: kind.to_owned(),
            strategy: strategy.to_owned(),
            original_bytes: original.len(),
            stored_bytes: stored.len(),
            compressed_bytes: compressed.len(),
            original_truncated: stored.len() < original.len(),
            retrieval_count,
        };
        if !self.entries.contains_key(&hash) {
            while self.entries.len() >= MAX_ENTRIES {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                }
            }
            self.order.push_back(hash.clone());
        }
        self.entries.insert(hash, entry.clone());
        Ok(entry)
    }

    pub fn retrieve(
        &mut self,
        hash: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Option<RetrievedContextWindow> {
        let entry = self.entries.get_mut(hash)?;
        entry.retrieval_count += 1;
        let total = entry.stored_bytes;
        let offset = offset.unwrap_or(0).min(total);
        let limit = limit
            .unwrap_or(RETRIEVAL_DEFAULT_BYTES)
            .clamp(1, RETRIEVAL_MAX_BYTES);
        let mut start = offset;
        while start < total && !entry.original.is_char_boundary(start) {
            start += 1
        }
        let mut end = (start + limit).min(total);
        while end > start && !entry.original.is_char_boundary(end) {
            end -= 1
        }
        let content = entry.original[start..end].to_owned();
        Some(RetrievedContextWindow {
            entry: entry.clone(),
            offset: start,
            bytes_shown: content.len(),
            total_bytes: total,
            content,
            next_offset: (end < total).then_some(end),
        })
    }

    pub fn has_entries(&self) -> bool {
        !self.entries.is_empty()
    }
    pub fn stats(&self) -> (usize, usize) {
        (
            self.entries.len(),
            self.entries.values().map(|entry| entry.stored_bytes).sum(),
        )
    }
}

#[derive(Debug, Clone)]
pub struct CompressionResult {
    pub output: String,
    pub modified: bool,
    pub strategy: String,
    pub kind: String,
    pub original_bytes: usize,
    pub output_bytes: usize,
    pub marker_hash: Option<String>,
}

fn classify_kind(tool_name: &str, output: &str) -> &'static str {
    let trimmed = output.trim_start();
    if tool_name == "search" {
        "search"
    } else if trimmed.starts_with("Directory:") {
        "directory"
    } else if trimmed.starts_with('{') || trimmed.starts_with('[') {
        "json"
    } else if tool_name == "command" {
        "log"
    } else if tool_name == "read" {
        "file"
    } else if output.lines().any(|line| line.starts_with("diff --git")) {
        "diff"
    } else {
        "plain_text"
    }
}

fn text_head_tail(output: &str, intro: &str) -> String {
    let lines: Vec<_> = output.lines().collect();
    let head = lines
        .iter()
        .take(120)
        .enumerate()
        .map(|(index, line)| format!("{}: {line}", index + 1));
    let tail_start = lines.len().saturating_sub(80);
    let tail = lines
        .iter()
        .skip(tail_start)
        .enumerate()
        .map(|(index, line)| format!("{}: {line}", tail_start + index + 1));
    clip_utf8(
        &format!(
            "{intro}\nTotal lines: {}\n\nHead:\n{}\n\nTail:\n{}",
            lines.len(),
            head.collect::<Vec<_>>().join("\n"),
            tail.collect::<Vec<_>>().join("\n")
        ),
        MAX_DISPLAYED_BYTES,
    )
}

fn compressed_body(tool_name: &str, output: &str, kind: &str) -> (String, &'static str) {
    if kind == "search" {
        let lines: Vec<_> = output.lines().filter(|line| !line.is_empty()).collect();
        let shown = lines
            .iter()
            .take(140)
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        return (
            clip_utf8(
                &format!(
                    "Search output compressed.\nTotal hits: {}\n\n{shown}",
                    lines.len()
                ),
                MAX_DISPLAYED_BYTES,
            ),
            "search_top_lines",
        );
    }
    if kind == "directory" {
        return (
            text_head_tail(output, "Directory output compressed."),
            "directory_grouped",
        );
    }
    if kind == "json"
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(output)
    {
        let pretty = serde_json::to_string_pretty(&value).unwrap_or_default();
        return (
            clip_utf8(
                &format!("JSON output compressed.\n{pretty}"),
                MAX_DISPLAYED_BYTES,
            ),
            "json_array_sample",
        );
    }
    if kind == "log" || tool_name == "command" {
        return (
            text_head_tail(output, "Command/log output compressed."),
            "log_errors_tail",
        );
    }
    (
        text_head_tail(output, "Text output compressed."),
        "text_head_tail",
    )
}

pub fn compress_tool_result(
    store: &mut SessionContextStore,
    tool_name: &str,
    tool_call_id: &str,
    title: &str,
    output: &str,
    status: &str,
) -> CompressionResult {
    let original_bytes = output.len();
    let kind = classify_kind(tool_name, output).to_owned();
    if tool_name == "retrieve_context" || original_bytes < MIN_COMPRESS_BYTES {
        return CompressionResult {
            output: output.to_owned(),
            modified: false,
            strategy: "passthrough".into(),
            kind,
            original_bytes,
            output_bytes: original_bytes,
            marker_hash: None,
        };
    }
    if regex::Regex::new(r"(?i)refusing blocked path|workspace_boundary|blocked path")
        .unwrap()
        .is_match(output)
        && !output.to_ascii_lowercase().contains("[redacted")
    {
        let clipped = clip_utf8(output, MAX_DISPLAYED_BYTES);
        return CompressionResult {
            output_bytes: clipped.len(),
            output: clipped,
            modified: original_bytes > MAX_DISPLAYED_BYTES,
            strategy: "text_head_tail".into(),
            kind,
            original_bytes,
            marker_hash: None,
        };
    }
    let (body, strategy) = compressed_body(tool_name, output, &kind);
    if body.len() >= original_bytes {
        return CompressionResult {
            output: output.to_owned(),
            modified: false,
            strategy: "passthrough".into(),
            kind,
            original_bytes,
            output_bytes: original_bytes,
            marker_hash: None,
        };
    }
    let (hash, _) = context_hash(output);
    let marker = format!(
        "<<umbratic-context:{hash} kind={kind} strategy={strategy} originalBytes={original_bytes} shownBytes={} storedBytes={}{}>>",
        body.len(),
        original_bytes.min(MAX_STORED_BYTES),
        if original_bytes > MAX_STORED_BYTES {
            " stored=capped"
        } else {
            ""
        }
    );
    let compressed = format!(
        "{body}\n\n{marker}\nUse retrieve_context with hash {hash} if exact omitted output is required."
    );
    let _ = store.store(
        tool_call_id,
        tool_name,
        title,
        output,
        &compressed,
        &kind,
        strategy,
    );
    let _ = status;
    CompressionResult {
        output_bytes: compressed.len(),
        output: compressed,
        modified: true,
        strategy: strategy.into(),
        kind,
        original_bytes,
        marker_hash: Some(hash),
    }
}

pub fn estimate_context_usage(
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
    context_length: u64,
    max_response_tokens: u64,
    protected_prompt_reserve_tokens: u64,
    additional: &[serde_json::Value],
) -> serde_json::Value {
    let serialized_bytes: usize = messages
        .iter()
        .chain(tools)
        .chain(additional)
        .map(|value| serde_json::to_string(value).unwrap_or_default().len())
        .sum();
    let message_overhead = messages.len() as u64 * 10;
    let image_tokens = messages
        .iter()
        .filter(|value| {
            serde_json::to_string(value)
                .unwrap_or_default()
                .contains("image_url")
        })
        .count() as u64
        * 1600;
    let content_tokens = serialized_bytes.div_ceil(4) as u64 + message_overhead + image_tokens;
    let reserve_tokens = max_response_tokens.min(context_length / 4)
        + protected_prompt_reserve_tokens.min(context_length / 4);
    serde_json::json!({ "contextLength": context_length, "contentTokens": content_tokens, "reserveTokens": reserve_tokens, "estimatedTokens": content_tokens + reserve_tokens })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_output_is_stored_and_retrievable() {
        let mut store = SessionContextStore::default();
        let source = "line of output\n".repeat(2000);
        let result =
            compress_tool_result(&mut store, "read", "call", "read BIG", &source, "success");
        assert!(result.modified);
        let hash = result.marker_hash.unwrap();
        let first = store.retrieve(&hash, None, Some(100)).unwrap();
        assert_eq!(first.offset, 0);
        assert_eq!(first.content, source[..first.bytes_shown]);
        assert_eq!(first.total_bytes, source.len());
        assert_eq!(first.next_offset, Some(first.bytes_shown));

        let second = store.retrieve(&hash, first.next_offset, Some(100)).unwrap();
        assert_eq!(second.offset, first.bytes_shown);
        assert_eq!(
            second.content,
            source[second.offset..second.offset + second.bytes_shown]
        );
        assert_eq!(store.stats(), (1, source.len()));
    }

    #[test]
    fn retrieval_offsets_preserve_utf8_boundaries_and_limits() {
        let mut store = SessionContextStore::default();
        let source = "é".repeat(20_000);
        let result =
            compress_tool_result(&mut store, "read", "call", "unicode", &source, "success");
        let window = store
            .retrieve(&result.marker_hash.unwrap(), Some(1), Some(17))
            .unwrap();
        assert_eq!(window.offset, 2);
        assert!(window.content.is_char_boundary(window.content.len()));
        assert!(window.bytes_shown <= 17);
    }
}
