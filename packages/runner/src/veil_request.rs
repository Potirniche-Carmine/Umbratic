//! The chat request body, and the two composer controls that change it.
//!
//! Kept apart from the transport in `veil_client` because it is pure: what
//! `chat_request_body` returns is exactly what leaves the process, so the wire
//! contract can be asserted without a live Veil.

use serde_json::{Value, json};

use crate::{config::RunnerConfig, veil_client::encoded_messages};

/// Whether the model must reason before answering. It decides what the model
/// does, never what the client is shown: reasoning content stays stripped
/// either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingDirective {
    On,
    Off,
}

impl ThinkingDirective {
    pub fn wire_value(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
        }
    }

    /// Reads the prompt body's `reasoningMode`. An unrecognized mode means no
    /// directive, which is the request a client that never sent one would make.
    pub fn from_reasoning_mode(value: &str) -> Option<Self> {
        match value.trim() {
            "reasoning" => Some(Self::On),
            "fast" => Some(Self::Off),
            _ => None,
        }
    }
}

/// Builds the chat body. Pure, so the wire contract can be asserted without a
/// live Veil: what this returns is exactly what leaves the process.
pub(crate) fn chat_request_body(
    config: &RunnerConfig,
    messages: &[Value],
    tools: &[Value],
    max_output_tokens: u64,
    include_tools: bool,
    harness_bucket: Option<&str>,
    thinking: Option<ThinkingDirective>,
) -> Value {
    let mut body = json!({
        "messages": encoded_messages(messages),
        "stream": true,
        "max_output_tokens": max_output_tokens
    });
    let object = body.as_object_mut().unwrap();
    if !config.skills.is_empty() {
        object.insert("skills".into(), Value::Array(config.skills.iter().map(|skill| json!({ "id":skill.id, "name":skill.name, "description":skill.description, "source":skill.source, "paths":skill.paths })).collect()));
    }
    if include_tools && !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools.to_vec()));
    }
    if let Some(bucket) = harness_bucket.filter(|value| !value.is_empty()) {
        object.insert("harness_bucket".into(), Value::String(bucket.to_owned()));
    }
    if let Some(directive) = thinking {
        object.insert(
            "thinking".into(),
            Value::String(directive.wire_value().to_owned()),
        );
    }
    // Naming the model is only admissible on a Veil that published a registry,
    // which the desktop confirms before setting this flag.
    if config.provider.send_model_field {
        object.insert(
            "model".into(),
            Value::String(config.provider.model_id.clone()),
        );
    }
    body
}
