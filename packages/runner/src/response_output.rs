use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    events::{increment, now_iso},
    session::{EventSink, Session},
};

const RAW_TOOL_MARKERS: [&str; 5] = [
    "<|tool",
    "<tool_call",
    "<tool*call",
    "</tool_call",
    "<function=",
];

pub(crate) fn looks_like_unstructured_tool_call(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    RAW_TOOL_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

#[derive(Default)]
pub(crate) struct SafeAssistantText {
    pending: String,
    blocked: bool,
}

impl SafeAssistantText {
    pub(crate) fn push(&mut self, value: &str) -> String {
        if self.blocked || value.is_empty() {
            return String::new();
        }
        self.pending.push_str(value);
        let normalized = self.pending.to_ascii_lowercase();
        if let Some(start) = RAW_TOOL_MARKERS
            .iter()
            .filter_map(|marker| normalized.find(marker))
            .min()
        {
            self.blocked = true;
            let safe = self.pending[..start].to_owned();
            self.pending.clear();
            return safe;
        }
        let mut held = 0;
        for marker in RAW_TOOL_MARKERS {
            for length in 1..marker.len() {
                if length <= normalized.len()
                    && normalized
                        .as_bytes()
                        .ends_with(&marker.as_bytes()[..length])
                {
                    held = held.max(length);
                }
            }
        }
        let emit_end = self.pending.len() - held;
        let safe = self.pending[..emit_end].to_owned();
        self.pending.drain(..emit_end);
        safe
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.blocked {
            self.pending.clear();
            return String::new();
        }
        std::mem::take(&mut self.pending)
    }
}

pub(crate) async fn record_answer(session: &Arc<Session>, summary: &mut Value, answer: &str) {
    increment(summary, "assistantTextChars", answer.len() as u64);
    session
        .messages
        .lock()
        .await
        .push(json!({"role":"assistant","content":answer}));
}

pub(crate) async fn emit_fallback_answer(
    session: &Arc<Session>,
    sink: &EventSink,
    summary: &mut Value,
    fallback: &str,
) {
    sink.emit(
        json!({"type":"assistant.delta","taskId":session.task_id,"text":fallback,"at":now_iso()}),
    );
    record_answer(session, summary, fallback).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_model_tool_syntax_is_not_valid_assistant_content() {
        assert!(looks_like_unstructured_tool_call(
            r#"<|tool*call>call:glob{glob:"src/*"}<tool*call|>"#
        ));
        assert!(looks_like_unstructured_tool_call(
            r#"<tool_call>{"name":"read"}</tool_call>"#
        ));
        assert!(!looks_like_unstructured_tool_call(
            "I will inspect the folder structure."
        ));
    }

    #[test]
    fn safe_text_streams_while_split_tool_markers_stay_hidden() {
        let mut safe = SafeAssistantText::default();
        assert_eq!(safe.push("I can help "), "I can help ");
        assert_eq!(safe.push("with code."), "with code.");
        assert_eq!(safe.finish(), "");

        let mut blocked = SafeAssistantText::default();
        assert_eq!(blocked.push("<|to"), "");
        assert_eq!(blocked.push("olcall>call:read{}"), "");
        assert_eq!(blocked.finish(), "");
    }
}
