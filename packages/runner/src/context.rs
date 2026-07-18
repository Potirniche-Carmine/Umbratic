use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use sha2::{Digest, Sha256};

const MIN_COMPRESS_BYTES: usize = 16 * 1024;
const MAX_DISPLAYED_BYTES: usize = 12 * 1024;
const MAX_STORED_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 64;
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
        let window = {
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
            RetrievedContextWindow {
                entry: entry.clone(),
                offset: start,
                bytes_shown: content.len(),
                total_bytes: total,
                content,
                next_offset: (end < total).then_some(end),
            }
        };
        self.order.retain(|entry_hash| entry_hash != hash);
        self.order.push_back(hash.to_owned());
        Some(window)
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
    } else if output.lines().any(|line| line.starts_with("diff --git")) {
        "diff"
    } else if tool_name == "command" {
        "log"
    } else if tool_name == "read" {
        "file"
    } else {
        "plain_text"
    }
}

fn numbered_lines(lines: &[&str], start: usize, byte_limit: usize) -> String {
    let mut output = String::new();
    for (offset, line) in lines.iter().enumerate() {
        let next = format!("{}: {line}\n", start + offset + 1);
        if output.len() + next.len() > byte_limit {
            break;
        }
        output.push_str(&next);
    }
    output.trim_end().to_owned()
}

fn numbered_tail_lines(lines: &[&str], start: usize, byte_limit: usize) -> String {
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    for (offset, line) in lines.iter().enumerate().rev() {
        let next = format!("{}: {line}", start + offset + 1);
        if bytes + next.len() + usize::from(!rows.is_empty()) > byte_limit {
            break;
        }
        bytes += next.len() + usize::from(!rows.is_empty());
        rows.push(next);
    }
    rows.reverse();
    rows.join("\n")
}

fn text_head_tail(output: &str, intro: &str, error_lines: bool) -> String {
    let lines: Vec<_> = output.lines().collect();
    let header = format!("{intro}\nTotal lines: {}\n", lines.len());
    let error_section = if error_lines {
        let errors = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                let lower = line.to_ascii_lowercase();
                lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("panic")
                    || lower.contains("fatal")
            })
            .collect::<Vec<_>>();
        if errors.is_empty() {
            String::new()
        } else {
            let mut rows = String::new();
            for (index, line) in errors {
                let next = format!("{}: {line}\n", index + 1);
                if rows.len() + next.len() > 2 * 1024 {
                    break;
                }
                rows.push_str(&next);
            }
            format!("\nErrors/failures:\n{}\n", rows.trim_end())
        }
    } else {
        String::new()
    };
    let fixed = header.len() + error_section.len() + 32;
    let available = MAX_DISPLAYED_BYTES.saturating_sub(fixed);
    let head_budget = available / 2;
    let tail_budget = available.saturating_sub(head_budget);
    let tail_start = lines.len().saturating_sub(160);
    format!(
        "{header}{error_section}\nHead:\n{}\n\nTail:\n{}",
        numbered_lines(&lines[..lines.len().min(160)], 0, head_budget),
        numbered_tail_lines(&lines[tail_start..], tail_start, tail_budget),
    )
}

fn compact_json_value(value: &serde_json::Value, limit: usize) -> String {
    let encoded = serde_json::to_string(value).unwrap_or_default();
    if encoded.len() <= limit {
        encoded
    } else {
        format!(
            "{}...(truncated)",
            clip_utf8(&encoded, limit.saturating_sub(14))
        )
    }
}

fn json_sample(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Array(values) => {
            let head = values
                .iter()
                .take(8)
                .enumerate()
                .map(|(index, value)| format!("{index}: {}", compact_json_value(value, 512)))
                .collect::<Vec<_>>();
            let tail_start = values.len().saturating_sub(8).max(head.len());
            let tail = values
                .iter()
                .skip(tail_start)
                .enumerate()
                .map(|(index, value)| {
                    format!("{}: {}", tail_start + index, compact_json_value(value, 512))
                })
                .collect::<Vec<_>>();
            format!(
                "JSON array output compressed.\nTotal entries: {}\n\nHead:\n{}\n\nTail:\n{}",
                values.len(),
                head.join("\n"),
                tail.join("\n")
            )
        }
        serde_json::Value::Object(values) => {
            let entries = values
                .iter()
                .take(20)
                .map(|(key, value)| format!("{key}: {}", compact_json_value(value, 512)))
                .collect::<Vec<_>>();
            format!(
                "JSON object output compressed.\nTotal keys: {}\n\n{}",
                values.len(),
                entries.join("\n")
            )
        }
        _ => format!(
            "JSON output compressed.\n{}",
            compact_json_value(value, 1024)
        ),
    }
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
            text_head_tail(output, "Directory output compressed.", false),
            "directory_grouped",
        );
    }
    if kind == "json"
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(output)
    {
        return (json_sample(&value), "json_array_sample");
    }
    if kind == "log" || tool_name == "command" {
        return (
            text_head_tail(output, "Command/log output compressed.", true),
            "log_errors_tail",
        );
    }
    (
        text_head_tail(output, "Text output compressed.", false),
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
        "{body}\n\n{marker}\nUse retrieve_context with hash {hash} if exact omitted output is required while it remains in the bounded session store."
    );
    if store
        .store(
            tool_call_id,
            tool_name,
            title,
            output,
            &compressed,
            &kind,
            strategy,
        )
        .is_err()
    {
        return CompressionResult {
            output_bytes: body.len(),
            output: body,
            modified: true,
            strategy: strategy.into(),
            kind,
            original_bytes,
            marker_hash: None,
        };
    }
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

fn estimate_string_tokens(value: &str) -> u64 {
    if value.starts_with("data:image/") {
        return 0;
    }
    let (ascii, non_ascii_bytes) = value.chars().fold((0usize, 0usize), |total, character| {
        if character.is_ascii() {
            (total.0 + 1, total.1)
        } else {
            (total.0, total.1 + character.len_utf8())
        }
    });
    ascii.div_ceil(4) as u64 + non_ascii_bytes.div_ceil(2) as u64
}

fn estimate_value_tokens(value: &serde_json::Value) -> u64 {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => 1,
        serde_json::Value::String(value) => estimate_string_tokens(value),
        serde_json::Value::Array(values) => {
            2 + values.iter().map(estimate_value_tokens).sum::<u64>()
        }
        serde_json::Value::Object(values) => {
            2 + values
                .iter()
                .map(|(key, value)| estimate_string_tokens(key) + estimate_value_tokens(value))
                .sum::<u64>()
        }
    }
}

fn count_images(value: &serde_json::Value) -> u64 {
    match value {
        serde_json::Value::Array(values) => values.iter().map(count_images).sum(),
        serde_json::Value::Object(values) => {
            u64::from(values.get("type").and_then(serde_json::Value::as_str) == Some("image_url"))
                + values.values().map(count_images).sum::<u64>()
        }
        _ => 0,
    }
}

pub fn effective_output_reserve(context_length: u64, max_response_tokens: u64) -> u64 {
    max_response_tokens.min(context_length / 2)
}

pub fn adaptive_output_reserve(
    context_length: u64,
    max_response_tokens: u64,
    prompt_tokens: u64,
) -> u64 {
    const MINIMUM_OUTPUT_TOKENS: u64 = 1_000;
    const OUTPUT_STEP_TOKENS: u64 = 1_000;
    let preferred = effective_output_reserve(context_length, max_response_tokens);
    let available = context_length.saturating_sub(prompt_tokens);
    if available >= preferred {
        return preferred;
    }
    if available < MINIMUM_OUTPUT_TOKENS {
        return preferred.min(MINIMUM_OUTPUT_TOKENS);
    }
    preferred.min((available / OUTPUT_STEP_TOKENS) * OUTPUT_STEP_TOKENS)
}

pub fn estimate_context_usage(
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
    context_length: u64,
    max_response_tokens: u64,
    protected_prompt_reserve_tokens: u64,
    additional: &[serde_json::Value],
) -> serde_json::Value {
    let value_tokens: u64 = messages
        .iter()
        .chain(tools)
        .chain(additional)
        .map(estimate_value_tokens)
        .sum();
    let message_overhead = messages.len() as u64 * 10;
    let image_tokens = messages.iter().map(count_images).sum::<u64>() * 1600;
    let protected_tokens = protected_prompt_reserve_tokens.min(context_length / 4);
    let prompt_tokens = value_tokens + message_overhead + image_tokens + protected_tokens;
    let reserve_tokens =
        adaptive_output_reserve(context_length, max_response_tokens, prompt_tokens);
    serde_json::json!({
        "contextLength": context_length,
        "contentTokens": prompt_tokens,
        "promptTokens": prompt_tokens,
        "completionTokens": 0,
        "reserveTokens": reserve_tokens,
        "protectedTokens": protected_tokens,
        "estimatedTokens": prompt_tokens + reserve_tokens,
        "phase": "preflight",
        "source": "heuristic",
        "confidence": "low"
    })
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

    #[test]
    fn head_tail_compression_preserves_both_ends_and_errors() {
        let middle = "middle line with enough padding to consume bytes\n".repeat(500);
        let source = format!("first line\n{middle}fatal: final failure\nlast line");
        let body = text_head_tail(&source, "Log compressed.", true);
        assert!(body.len() <= MAX_DISPLAYED_BYTES);
        assert!(body.contains("first line"));
        assert!(body.contains("fatal: final failure"));
        assert!(body.contains("last line"));
    }

    #[test]
    fn diff_classification_wins_over_tool_kind() {
        assert_eq!(
            classify_kind("command", "diff --git a/a b/a\n+next"),
            "diff"
        );
        assert_eq!(classify_kind("read", "diff --git a/a b/a\n+next"), "diff");
    }

    #[test]
    fn json_compression_samples_both_ends_structurally() {
        let source = serde_json::to_string(
            &(0..100)
                .map(|index| serde_json::json!({"index":index,"payload":"x".repeat(1000)}))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let body = json_sample(&serde_json::from_str(&source).unwrap());
        assert!(body.contains("0: {"));
        assert!(body.contains("99: {"));
        assert!(body.contains("Total entries: 100"));
        assert!(body.len() <= MAX_DISPLAYED_BYTES);
    }

    #[test]
    fn context_estimate_does_not_count_base64_as_text_and_handles_unicode_conservatively() {
        let messages = vec![serde_json::json!({"role":"user","content":[
            {"type":"text","text":"你好🙂"},
            {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "A".repeat(100_000))}}
        ]})];
        let usage = estimate_context_usage(&messages, &[], 64_000, 4_096, 4_096, &[]);
        assert!(usage["contentTokens"].as_u64().unwrap() < 6_000);
        assert_eq!(usage["reserveTokens"], 4_096);
        assert_eq!(usage["phase"], "preflight");
        assert_eq!(usage["source"], "heuristic");
    }

    #[test]
    fn output_reserve_grows_to_eight_thousand_and_keeps_a_one_thousand_token_minimum() {
        assert_eq!(adaptive_output_reserve(16_000, 8_192, 8_000), 8_000);
        assert_eq!(adaptive_output_reserve(16_000, 8_192, 12_400), 3_000);
        assert_eq!(adaptive_output_reserve(16_000, 8_192, 13_400), 2_000);
        assert_eq!(adaptive_output_reserve(16_000, 8_192, 14_400), 1_000);
        assert_eq!(adaptive_output_reserve(16_000, 8_192, 15_400), 1_000);
    }

    #[test]
    fn context_estimate_uses_the_adaptive_response_allowance() {
        let messages = vec![serde_json::json!({"role":"user","content":"x".repeat(49_000)})];
        let usage = estimate_context_usage(&messages, &[], 16_000, 4_096, 0, &[]);
        assert_eq!(usage["reserveTokens"], 3_000);
        assert!(usage["estimatedTokens"].as_u64().unwrap() <= 16_000);
    }

    #[test]
    fn retrieval_refreshes_lru_retention() {
        let mut store = SessionContextStore::default();
        for index in 0..MAX_ENTRIES {
            let source = format!("entry {index} {}", "x".repeat(MIN_COMPRESS_BYTES));
            let result = compress_tool_result(
                &mut store,
                "read",
                &format!("call-{index}"),
                "read",
                &source,
                "success",
            );
            assert!(result.marker_hash.is_some());
        }
        let oldest = store.order.front().cloned().unwrap();
        assert!(store.retrieve(&oldest, None, Some(10)).is_some());
        let source = format!("new entry {}", "y".repeat(MIN_COMPRESS_BYTES));
        let _ = compress_tool_result(&mut store, "read", "new", "read", &source, "success");
        assert!(store.retrieve(&oldest, None, Some(10)).is_some());
    }
}
