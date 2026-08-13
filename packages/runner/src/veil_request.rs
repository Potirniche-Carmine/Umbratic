//! The chat request body, and the composer control that changes it.
//!
//! Kept apart from the transport in `veil_client` because it is pure: what
//! `chat_request_body` returns is exactly what leaves the process, so the wire
//! contract can be asserted without a live Veil.

use serde_json::{Value, json};

use crate::{config::RunnerConfig, veil_client::encoded_messages};

/// Builds the chat body. Pure, so the wire contract can be asserted without a
/// live Veil: what this returns is exactly what leaves the process.
pub(crate) fn chat_request_body(
    config: &RunnerConfig,
    messages: &[Value],
    tools: &[Value],
    max_output_tokens: u64,
    include_tools: bool,
    harness_bucket: Option<&str>,
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
