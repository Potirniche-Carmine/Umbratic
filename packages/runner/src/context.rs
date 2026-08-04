use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MIN_COMPRESS_BYTES: usize = 16 * 1024;
const MAX_DISPLAYED_BYTES: usize = 16 * 1024;
const MAX_STORED_BYTES: usize = 512 * 1024;
const MAX_ENTRIES: usize = 64;
const RETRIEVAL_DEFAULT_BYTES: usize = 16 * 1024;
const RETRIEVAL_MAX_BYTES: usize = 32 * 1024;

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

/// Compacts one tool result. `declared_kind` is the output shape the tool
/// catalog declares, so classification never depends on the model-facing text.
pub fn compress_tool_result(
    store: &mut SessionContextStore,
    tool_name: &str,
    declared_kind: &str,
    tool_call_id: &str,
    title: &str,
    output: &str,
    status: &str,
) -> CompressionResult {
    let original_bytes = output.len();
    let kind = declared_kind.to_owned();
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

fn encoded_json_string_len(value: &str) -> usize {
    2 + value
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{0008}' | '\u{000c}' | '\n' | '\r' | '\t' => 2,
            '\u{0000}'..='\u{001f}' => 6,
            _ => character.len_utf8(),
        })
        .sum::<usize>()
}

fn encoded_json_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(number) => number.to_string().len(),
        Value::String(text) => encoded_json_string_len(text),
        Value::Array(values) => {
            2 + values.len().saturating_sub(1) + values.iter().map(encoded_json_len).sum::<usize>()
        }
        Value::Object(values) => {
            2 + values.len().saturating_sub(1)
                + values
                    .iter()
                    .map(|(key, value)| {
                        encoded_json_string_len(key)
                            .saturating_add(1)
                            .saturating_add(encoded_json_len(value))
                    })
                    .sum::<usize>()
        }
    }
}

fn encoded_json_array_len(values: &[Value]) -> usize {
    2 + values.len().saturating_sub(1) + values.iter().map(encoded_json_len).sum::<usize>()
}

fn estimate_json_array_tokens(values: &[Value]) -> u64 {
    encoded_json_array_len(values).div_ceil(3) as u64
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextUsageEstimate {
    pub context_length: u64,
    pub heuristic_prompt_tokens: u64,
    pub calibrated_prompt_tokens: u64,
    pub reserve_tokens: u64,
    pub protected_tokens: u64,
}

impl ContextUsageEstimate {
    pub fn estimated_tokens(self) -> u64 {
        self.calibrated_prompt_tokens
            .saturating_add(self.reserve_tokens)
    }

    pub fn event(self) -> Value {
        json!({
            "contextLength": self.context_length,
            "contentTokens": self.calibrated_prompt_tokens,
            "promptTokens": self.calibrated_prompt_tokens,
            "completionTokens": 0,
            "reserveTokens": self.reserve_tokens,
            "protectedTokens": self.protected_tokens,
            "estimatedTokens": self.estimated_tokens(),
            "phase": "preflight",
            "source": "heuristic",
            "confidence": "low"
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextCalibration {
    pub profile_fingerprint: String,
    pub multiplier_milli: u32,
    pub observed_prompt_tokens: u64,
    pub estimated_prompt_tokens: u64,
}

impl ContextCalibration {
    pub fn from_observation(
        profile_fingerprint: String,
        observed_prompt_tokens: u64,
        estimated_prompt_tokens: u64,
        context_length: u64,
    ) -> Option<Self> {
        if observed_prompt_tokens == 0
            || estimated_prompt_tokens == 0
            || observed_prompt_tokens > context_length
        {
            return None;
        }
        let numerator = u128::from(observed_prompt_tokens).saturating_mul(1_000);
        let denominator = u128::from(estimated_prompt_tokens);
        let rounded_up = numerator.saturating_add(denominator.saturating_sub(1)) / denominator;
        let multiplier_milli = rounded_up.clamp(1_000, 1_500) as u32;
        Some(Self {
            profile_fingerprint,
            multiplier_milli,
            observed_prompt_tokens,
            estimated_prompt_tokens,
        })
    }

    pub fn apply(&self, profile_fingerprint: &str, prompt_tokens: u64) -> u64 {
        if self.profile_fingerprint != profile_fingerprint {
            return prompt_tokens;
        }
        let calibrated = u128::from(prompt_tokens)
            .saturating_mul(u128::from(self.multiplier_milli))
            .saturating_add(999)
            / 1_000;
        calibrated.min(u128::from(u64::MAX)) as u64
    }
}

pub fn request_profile_fingerprint(
    model_id: &str,
    route: &str,
    context_length: u64,
    protected_prompt_reserve_tokens: u64,
    tools: &[Value],
    skills: &[Value],
) -> String {
    struct DigestWriter<'a>(&'a mut Sha256);
    impl std::io::Write for DigestWriter<'_> {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.update(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut digest = Sha256::new();
    for value in [model_id, route] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    digest.update(context_length.to_le_bytes());
    digest.update(protected_prompt_reserve_tokens.to_le_bytes());
    let _ = serde_json::to_writer(DigestWriter(&mut digest), tools);
    digest.update([0]);
    let _ = serde_json::to_writer(DigestWriter(&mut digest), skills);
    format!("{:x}", digest.finalize())
}

pub fn estimate_context_usage(
    messages: &[Value],
    tools: &[Value],
    context_length: u64,
    max_response_tokens: u64,
    protected_prompt_reserve_tokens: u64,
    additional: &[Value],
) -> ContextUsageEstimate {
    let value_tokens = estimate_json_array_tokens(messages)
        + estimate_json_array_tokens(tools)
        + additional
            .iter()
            .map(|value| encoded_json_len(value).div_ceil(3) as u64)
            .sum::<u64>();
    let message_overhead = messages.len() as u64 * 10;
    let image_tokens = messages.iter().map(count_images).sum::<u64>() * 1600;
    let protected_tokens = protected_prompt_reserve_tokens.min(context_length / 4);
    let prompt_tokens = value_tokens + message_overhead + image_tokens + protected_tokens;
    let reserve_tokens =
        adaptive_output_reserve(context_length, max_response_tokens, prompt_tokens);
    ContextUsageEstimate {
        context_length,
        heuristic_prompt_tokens: prompt_tokens,
        calibrated_prompt_tokens: prompt_tokens,
        reserve_tokens,
        protected_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocation_free_json_length_matches_serde_json_encoding() {
        let values = vec![
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!(123.5),
            serde_json::json!("quote \" slash \\ controls \n \u{0001} unicode 中🙂"),
            serde_json::json!({"key":"value","nested":[1,false,null]}),
        ];
        for value in &values {
            assert_eq!(
                encoded_json_len(value),
                serde_json::to_vec(value).unwrap().len(),
                "{value}"
            );
        }
        assert_eq!(
            encoded_json_array_len(&values),
            serde_json::to_vec(&values).unwrap().len()
        );
    }

    #[test]
    fn large_output_is_stored_and_retrievable() {
        let mut store = SessionContextStore::default();
        let source = "line of output\n".repeat(2000);
        let result = compress_tool_result(
            &mut store, "read", "file", "call", "read BIG", &source, "success",
        );
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
        let result = compress_tool_result(
            &mut store, "read", "file", "call", "unicode", &source, "success",
        );
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
    fn compaction_uses_the_declared_kind_not_the_output_text() {
        // A command whose output happens to look like a diff is still a log.
        let mut store = SessionContextStore::default();
        let source = format!("diff --git a/a b/a{}", "+next".repeat(MIN_COMPRESS_BYTES));
        let result = compress_tool_result(
            &mut store, "command", "log", "call", "cmd", &source, "success",
        );
        assert_eq!(result.kind, "log");
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
    fn context_estimate_matches_veil_json_accounting_and_handles_images_conservatively() {
        let messages = vec![serde_json::json!({"role":"user","content":[
            {"type":"text","text":"你好🙂"},
            {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "A".repeat(100_000))}}
        ]})];
        let usage = estimate_context_usage(&messages, &[], 64_000, 4_096, 4_096, &[]);
        let veil_value_tokens = serde_json::to_vec(&messages).unwrap().len().div_ceil(3) as u64
            + serde_json::to_vec(&Vec::<serde_json::Value>::new())
                .unwrap()
                .len()
                .div_ceil(3) as u64;
        assert_eq!(
            usage.calibrated_prompt_tokens,
            veil_value_tokens + 10 + 1_600 + 4_096
        );
        assert_eq!(usage.reserve_tokens, 4_096);
        assert_eq!(usage.event()["phase"], "preflight");
        assert_eq!(usage.event()["source"], "heuristic");
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
        let messages = vec![serde_json::json!({"role":"user","content":"x".repeat(37_000)})];
        let usage = estimate_context_usage(&messages, &[], 16_000, 4_096, 0, &[]);
        assert_eq!(usage.reserve_tokens, 3_000);
        assert!(usage.estimated_tokens() <= 16_000);
    }

    #[test]
    fn calibration_is_conservative_bounded_and_profile_scoped() {
        let calibration =
            ContextCalibration::from_observation("profile-a".into(), 1_200, 1_000, 8_000).unwrap();
        assert_eq!(calibration.multiplier_milli, 1_200);
        assert_eq!(calibration.apply("profile-a", 2_000), 2_400);
        assert_eq!(calibration.apply("profile-b", 2_000), 2_000);

        let downward = ContextCalibration::from_observation("p".into(), 800, 1_000, 8_000).unwrap();
        assert_eq!(downward.multiplier_milli, 1_000);
        let upward = ContextCalibration::from_observation("p".into(), 2_000, 1_000, 8_000).unwrap();
        assert_eq!(upward.multiplier_milli, 1_500);
        assert!(ContextCalibration::from_observation("p".into(), 0, 1_000, 8_000).is_none());
        assert!(ContextCalibration::from_observation("p".into(), 8_001, 1_000, 8_000).is_none());
    }

    #[test]
    fn calibration_arithmetic_saturates_without_overflow() {
        let calibration = ContextCalibration {
            profile_fingerprint: "p".into(),
            multiplier_milli: 1_500,
            observed_prompt_tokens: u64::MAX,
            estimated_prompt_tokens: u64::MAX,
        };
        assert_eq!(calibration.apply("p", u64::MAX), u64::MAX);
    }

    #[test]
    fn request_profile_changes_with_tools_and_skills() {
        let base =
            request_profile_fingerprint("model", "/api/engineering/chat", 64_000, 2_048, &[], &[]);
        let tool = request_profile_fingerprint(
            "model",
            "/api/engineering/chat",
            64_000,
            2_048,
            &[serde_json::json!({"name":"read"})],
            &[],
        );
        let skill = request_profile_fingerprint(
            "model",
            "/api/engineering/chat",
            64_000,
            2_048,
            &[],
            &[serde_json::json!({"id":"docs"})],
        );
        assert_ne!(base, tool);
        assert_ne!(base, skill);
        assert_ne!(tool, skill);
    }

    #[test]
    fn retrieval_refreshes_lru_retention() {
        let mut store = SessionContextStore::default();
        for index in 0..MAX_ENTRIES {
            let source = format!("entry {index} {}", "x".repeat(MIN_COMPRESS_BYTES));
            let result = compress_tool_result(
                &mut store,
                "read",
                "file",
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
        let _ = compress_tool_result(
            &mut store, "read", "file", "new", "read", &source, "success",
        );
        assert!(store.retrieve(&oldest, None, Some(10)).is_some());
    }
}
