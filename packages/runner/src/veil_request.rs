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
    // Naming the model is only admissible on a Veil that published a registry,
    // which the desktop confirms before setting this flag.
    if config.provider.send_model_field {
        object.insert(
            "model".into(),
            Value::String(config.provider.model_id.clone()),
        );
    }
    // Same gating as `model`: an older Veil that never advertised the toggle
    // must see the body it has always seen.
    if config.provider.send_thinking_field
        && let Some(thinking) = config
            .provider
            .thinking
            .as_deref()
            .filter(|value| crate::config::valid_reasoning_level(value))
    {
        object.insert("thinking".into(), Value::String(thinking.to_owned()));
    }
    // Same gating as `thinking`: an older Veil that never advertised the
    // feature must see the body it has always seen. Only the true case is
    // sent — absent means strip, which is also the default.
    if config.provider.send_reasoning_visible_field && config.provider.reasoning_visible {
        object.insert("reasoning_visible".into(), Value::Bool(true));
    }
    body
}
