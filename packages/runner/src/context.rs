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
    // A result that did not succeed is a diagnosis, and the whole of it is the
    // point: it is clipped to the display bound but never folded into a
    // head-and-tail sample. This used to be decided by matching the output text
    // against refusal phrasings ("refusing blocked path", "workspace_boundary").
    // Every phrasing it looked for is produced on the error path, which never
    // reaches this function, so the match only ever fired on a successful result
    // that happened to *discuss* blocked paths — a search hit in this very file
    // would do it — and silently opted that result out of compaction. The status
    // is already an argument; it answers the question exactly.
    if status != "success" {
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
    // JSON preserves UTF-8 bytes; only ASCII quotes, backslashes and controls
    // add escape bytes. Avoid decoding every character in the active view.
    let mut length = 2 + value.len();
    for &byte in value.as_bytes() {
        if byte < 0x20 {
            length += match byte {
                b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => 1,
                _ => 5,
            };
        } else if byte == b'"' || byte == b'\\' {
            length += 1;
        }
    }
    length
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

/// Row-level JSON length with image payloads elided.
///
/// An inline `data:` image is tens of kilobytes of base64 that costs a flat
/// per-image price at the runtime, not one token per three bytes. Counting it
/// by length would make the conversation row wrong by an order of magnitude, so
/// images are priced once in their own row instead.
fn encoded_json_len_excluding_images(value: &Value) -> usize {
    match value {
        Value::Object(values)
            if values.get("type").and_then(Value::as_str) == Some("image_url") =>
        {
            IMAGE_PLACEHOLDER_LEN
        }
        Value::Array(values) => {
            2 + values.len().saturating_sub(1)
                + values
                    .iter()
                    .map(encoded_json_len_excluding_images)
                    .sum::<usize>()
        }
        Value::Object(values) => {
            2 + values.len().saturating_sub(1)
                + values
                    .iter()
                    .map(|(key, value)| {
                        encoded_json_string_len(key)
                            .saturating_add(1)
                            .saturating_add(encoded_json_len_excluding_images(value))
                    })
                    .sum::<usize>()
        }
        value => encoded_json_len(value),
    }
}

const IMAGE_PLACEHOLDER_LEN: usize = 24;
const MESSAGE_OVERHEAD_TOKENS: u64 = 10;
const IMAGE_TOKENS: u64 = 1_600;

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

/// The provider-reported size of the settled context.
///
/// `prompt_tokens` is by definition the exact size of everything that was sent:
/// Veil's protected prefix, the tool definitions, the skill catalog, and every
/// message up to `anchor_len`. Nothing about it needs a local tokenizer. Only
/// the un-sent tail beyond `anchor_len` is estimated on top of it, until the
/// next response replaces the whole number with a fresh measurement.
///
/// `anchor_len` is `messages.len()` *after* the assistant turn was appended, so
/// `completion_tokens` accounts for the part of the response that will be
/// resent. The stored assistant message drops the preamble the model streamed,
/// which makes the anchor a slight over-count — the safe direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageAnchor {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub anchor_len: usize,
}

impl UsageAnchor {
    pub fn total(self) -> u64 {
        self.prompt_tokens.saturating_add(self.completion_tokens)
    }
}

/// The measured size of Veil's protected prefix, which the runner never sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemPromptSize {
    pub tokens: u64,
    pub exact: bool,
}

/// Per-category estimates over the actually assembled request.
///
/// The raw rows are heuristic byte counts and share the estimator's bias, so
/// before they are reported they are reconciled to the headline total with
/// `reconciled_to`. The headline is the best-known size (heuristic, calibrated,
/// anchored, or provider-measured); rows that sum past it are all wrong by the
/// same shared bias, and a meter whose parts exceed its whole reads as broken —
/// which is exactly how it was reported from a live session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ContextBreakdown {
    pub system_prompt_tokens: u64,
    pub system_prompt_exact: bool,
    pub tool_definition_tokens: u64,
    pub skill_tokens: u64,
    pub conversation_tokens: u64,
    pub tool_result_tokens: u64,
    pub image_tokens: u64,
}

impl ContextBreakdown {
    pub fn event(self) -> Value {
        json!({
            "systemPromptTokens": self.system_prompt_tokens,
            "systemPromptExact": self.system_prompt_exact,
            "toolDefinitionTokens": self.tool_definition_tokens,
            "skillTokens": self.skill_tokens,
            "conversationTokens": self.conversation_tokens,
            "toolResultTokens": self.tool_result_tokens,
            "imageTokens": self.image_tokens,
        })
    }

    /// Rescales the estimated rows so they sum exactly to `content_tokens`.
    ///
    /// The rows keep their relative proportions; the shared bytes-to-tokens
    /// bias is corrected by the known total, the same way calibration corrects
    /// the headline. An exact system-prompt measurement is preserved rather
    /// than scaled, and integer rounding lands on the conversation row so the
    /// sum is exact.
    pub fn reconciled_to(self, content_tokens: u64) -> ContextBreakdown {
        let fixed = if self.system_prompt_exact {
            self.system_prompt_tokens.min(content_tokens)
        } else {
            0
        };
        let available = content_tokens.saturating_sub(fixed);
        let estimated_system = if self.system_prompt_exact {
            0
        } else {
            self.system_prompt_tokens
        };
        let estimated = estimated_system
            + self.tool_definition_tokens
            + self.skill_tokens
            + self.conversation_tokens
            + self.tool_result_tokens
            + self.image_tokens;
        let scale = |row: u64| -> u64 {
            if estimated == 0 {
                0
            } else {
                (u128::from(row) * u128::from(available) / u128::from(estimated)) as u64
            }
        };
        let mut reconciled = ContextBreakdown {
            system_prompt_tokens: if self.system_prompt_exact {
                fixed
            } else {
                scale(self.system_prompt_tokens)
            },
            system_prompt_exact: self.system_prompt_exact,
            tool_definition_tokens: scale(self.tool_definition_tokens),
            skill_tokens: scale(self.skill_tokens),
            conversation_tokens: scale(self.conversation_tokens),
            tool_result_tokens: scale(self.tool_result_tokens),
            image_tokens: scale(self.image_tokens),
        };
        let allocated = if self.system_prompt_exact {
            0
        } else {
            reconciled.system_prompt_tokens
        } + reconciled.tool_definition_tokens
            + reconciled.skill_tokens
            + reconciled.conversation_tokens
            + reconciled.tool_result_tokens
            + reconciled.image_tokens;
        reconciled.conversation_tokens += available.saturating_sub(allocated);
        reconciled
    }
}

fn row_tokens<'a>(messages: impl Iterator<Item = &'a Value>) -> u64 {
    let mut count = 0u64;
    let mut bytes = 0usize;
    for message in messages {
        count += 1;
        bytes = bytes.saturating_add(encoded_json_len_excluding_images(message));
    }
    if count == 0 {
        return 0;
    }
    (bytes.div_ceil(3) as u64).saturating_add(count * MESSAGE_OVERHEAD_TOKENS)
}

fn is_tool_result(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("tool")
}

pub fn context_breakdown(
    messages: &[Value],
    tools: &[Value],
    skills: &[Value],
    system_prompt: SystemPromptSize,
) -> ContextBreakdown {
    ContextBreakdown {
        system_prompt_tokens: system_prompt.tokens,
        system_prompt_exact: system_prompt.exact,
        tool_definition_tokens: array_tokens(tools),
        skill_tokens: array_tokens(skills),
        conversation_tokens: row_tokens(messages.iter().filter(|message| !is_tool_result(message))),
        tool_result_tokens: row_tokens(messages.iter().filter(|message| is_tool_result(message))),
        image_tokens: messages.iter().map(count_images).sum::<u64>() * IMAGE_TOKENS,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextUsageEstimate {
    pub context_length: u64,
    pub heuristic_prompt_tokens: u64,
    pub calibrated_prompt_tokens: u64,
    pub reserve_tokens: u64,
    pub protected_tokens: u64,
    /// True when `calibrated_prompt_tokens` is a provider measurement plus an
    /// estimated un-sent tail, rather than an estimate of the whole prompt.
    pub anchored: bool,
    pub breakdown: ContextBreakdown,
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
            // The protected prefix is part of the prompt, never more than it.
            "protectedTokens": self.protected_tokens.min(self.calibrated_prompt_tokens),
            "estimatedTokens": self.estimated_tokens(),
            "phase": "preflight",
            "source": if self.anchored { "provider" } else { "heuristic" },
            "confidence": if self.anchored { "high" } else { "low" },
            "anchored": self.anchored,
            "breakdown": self
                .breakdown
                .reconciled_to(self.calibrated_prompt_tokens)
                .event(),
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

pub struct ContextEstimateInput<'a> {
    pub messages: &'a [Value],
    pub tools: &'a [Value],
    pub skills: &'a [Value],
    pub context_length: u64,
    pub max_response_tokens: u64,
    pub protected_prompt_reserve_tokens: u64,
    /// Veil's measurement of its own protected prefix, when it reported one.
    pub system_prompt: Option<SystemPromptSize>,
    pub anchor: Option<UsageAnchor>,
}

fn array_tokens(values: &[Value]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    estimate_json_array_tokens(values)
}

fn tail_estimate(messages: &[Value]) -> u64 {
    if messages.is_empty() {
        return 0;
    }
    estimate_json_array_tokens(messages)
        + messages.len() as u64 * MESSAGE_OVERHEAD_TOKENS
        + messages.iter().map(count_images).sum::<u64>() * IMAGE_TOKENS
}

pub fn estimate_context_usage(input: ContextEstimateInput<'_>) -> ContextUsageEstimate {
    let ContextEstimateInput {
        messages,
        tools,
        skills,
        context_length,
        max_response_tokens,
        protected_prompt_reserve_tokens,
        system_prompt,
        anchor,
    } = input;
    let system_prompt = system_prompt.unwrap_or(SystemPromptSize {
        tokens: protected_prompt_reserve_tokens.min(context_length / 4),
        exact: false,
    });
    let protected_tokens = system_prompt.tokens;
    let value_tokens = estimate_json_array_tokens(messages)
        + estimate_json_array_tokens(tools)
        + array_tokens(skills);
    let message_overhead = messages.len() as u64 * MESSAGE_OVERHEAD_TOKENS;
    let image_tokens = messages.iter().map(count_images).sum::<u64>() * IMAGE_TOKENS;
    let heuristic_prompt_tokens = value_tokens + message_overhead + image_tokens + protected_tokens;
    // A live anchor makes the settled prefix a measurement, so only the tail
    // appended since that response is guessed at.
    let (prompt_tokens, anchored) = match anchor {
        Some(anchor) if messages.len() >= anchor.anchor_len => (
            anchor
                .total()
                .saturating_add(tail_estimate(&messages[anchor.anchor_len..])),
            true,
        ),
        _ => (heuristic_prompt_tokens, false),
    };
    let reserve_tokens =
        adaptive_output_reserve(context_length, max_response_tokens, prompt_tokens);
    ContextUsageEstimate {
        context_length,
        heuristic_prompt_tokens,
        calibrated_prompt_tokens: prompt_tokens,
        reserve_tokens,
        protected_tokens,
        anchored,
        breakdown: context_breakdown(messages, tools, skills, system_prompt),
    }
}
#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
