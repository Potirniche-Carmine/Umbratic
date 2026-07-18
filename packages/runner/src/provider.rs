use std::{
    collections::{BTreeMap, HashSet},
    fs,
    net::ToSocketAddrs,
};

use futures_util::StreamExt;
use reqwest::{Certificate, Client, Identity, tls::Version};
use serde_json::{Map, Value, json};

use crate::{
    config::{ProviderConfig, provider_endpoint_url},
    events::now_iso,
    session::{EventSink, Session},
    tools::ToolCall,
};

#[derive(Debug, Clone, Default)]
pub struct ProviderResult {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub action_requirement: String,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub truncated_tool_arguments: bool,
}

fn client_for(provider: &ProviderConfig) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .min_tls_version(Version::TLS_1_2)
        .tls_info(true);
    if let Some(mtls) = &provider.mtls {
        if let Some(server_name) = &mtls.server_name {
            let base = url::Url::parse(&provider.base_url).map_err(|error| error.to_string())?;
            let host = base
                .host_str()
                .ok_or_else(|| "Provider base URL has no host".to_owned())?;
            let port = base
                .port_or_known_default()
                .ok_or_else(|| "Provider base URL has no port".to_owned())?;
            let addresses = (host, port)
                .to_socket_addrs()
                .map_err(|error| format!("Unable to resolve provider host: {error}"))?
                .collect::<Vec<_>>();
            if addresses.is_empty() {
                return Err("Provider host did not resolve to an address.".into());
            }
            builder = builder.resolve_to_addrs(server_name, &addresses);
        }
        if let Some(path) = &mtls.ca_path {
            let certificate = Certificate::from_pem(
                &fs::read(path).map_err(|error| format!("Unable to read mTLS CA: {error}"))?,
            )
            .map_err(|error| format!("Invalid mTLS CA: {error}"))?;
            builder = builder.add_root_certificate(certificate);
        }
        match (&mtls.cert_path, &mtls.key_path) {
            (Some(cert), Some(key)) => {
                let mut identity = fs::read(cert)
                    .map_err(|error| format!("Unable to read mTLS certificate: {error}"))?;
                identity.extend_from_slice(b"\n");
                identity.extend_from_slice(
                    &fs::read(key).map_err(|error| format!("Unable to read mTLS key: {error}"))?,
                );
                builder = builder.use_rustls_tls().identity(
                    Identity::from_pem(&identity)
                        .map_err(|error| format!("Invalid mTLS identity: {error}"))?,
                );
            }
            (None, None) => {}
            _ => return Err("mTLS certPath and keyPath must be configured together.".into()),
        }
    }
    builder.build().map_err(|error| error.to_string())
}

fn request_endpoint(provider: &ProviderConfig) -> Result<(url::Url, Option<String>), String> {
    let mut endpoint = provider_endpoint_url(provider)?;
    let Some(server_name) = provider
        .mtls
        .as_ref()
        .and_then(|mtls| mtls.server_name.as_deref())
    else {
        return Ok((endpoint, None));
    };
    let original_host = endpoint
        .host_str()
        .ok_or_else(|| "Provider endpoint has no host".to_owned())?;
    let host_header = match endpoint.port() {
        Some(port) => format!("{original_host}:{port}"),
        None => original_host.to_owned(),
    };
    endpoint
        .set_host(Some(server_name))
        .map_err(|_| "Invalid mTLS serverName override".to_owned())?;
    Ok((endpoint, Some(host_header)))
}

fn normalize_sha256_fingerprint(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("sha256:")
        .or_else(|| normalized.strip_prefix("sha256/"))
        .unwrap_or(&normalized);
    normalized.chars().filter(char::is_ascii_hexdigit).collect()
}

fn verify_certificate_pin(
    provider: &ProviderConfig,
    response: &reqwest::Response,
) -> Result<(), String> {
    let Some(expected) = provider
        .mtls
        .as_ref()
        .and_then(|mtls| mtls.pinned_server_certificate_sha256.as_deref())
    else {
        return Ok(());
    };
    let expected = normalize_sha256_fingerprint(expected);
    if expected.len() != 64 {
        return Err(
            "Pinned server certificate SHA-256 must contain 64 hexadecimal characters.".into(),
        );
    }
    let certificate = response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .and_then(reqwest::tls::TlsInfo::peer_certificate)
        .ok_or_else(|| {
            "Pinned server certificate was unavailable from the TLS connection.".to_owned()
        })?;
    use sha2::Digest;
    let actual = format!("{:x}", sha2::Sha256::digest(certificate));
    if actual != expected {
        return Err("Pinned server certificate mismatch.".into());
    }
    Ok(())
}

fn text_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_owned)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_owned))
            })
            .collect(),
        _ => String::new(),
    }
}

fn emit_content(
    sink: &EventSink,
    session: &Session,
    result: &mut ProviderResult,
    text: String,
    answer_started: &mut bool,
    suppress_output: bool,
) {
    if text.is_empty() {
        return;
    }
    result.content.push_str(&text);
    if suppress_output {
        return;
    }
    if !*answer_started {
        sink.emit(json!({ "type": "assistant.answer.started", "taskId": session.task_id, "at": now_iso() }));
        *answer_started = true;
    }
    sink.emit(json!({ "type": "assistant.delta", "taskId": session.task_id, "text": text, "at": now_iso() }));
}

fn emit_reasoning(sink: &EventSink, session: &Session, result: &mut ProviderResult, text: String) {
    if text.is_empty() {
        return;
    }
    result.reasoning.push_str(&text);
    sink.emit(json!({ "type": "assistant.reasoning.delta", "taskId": session.task_id, "text": text, "at": now_iso() }));
}

fn append_openai_delta(
    result: &mut ProviderResult,
    delta: &Map<String, Value>,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) {
    for raw in delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(call) = raw.as_object() else {
            continue;
        };
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let function = call.get("function").and_then(Value::as_object);
        let existing = partial.entry(index).or_default();
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            existing.0 = id.to_owned();
        }
        if let Some(name) = function
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
        {
            existing.1 = name.to_owned();
        }
        if let Some(arguments) = function
            .and_then(|value| value.get("arguments"))
            .and_then(Value::as_str)
        {
            existing.2.push_str(arguments);
        }
    }
    result.tool_calls = partial
        .iter()
        .map(|(index, (id, name, arguments))| ToolCall {
            id: if id.is_empty() {
                format!("tool-call-{index}")
            } else {
                id.clone()
            },
            name: name.clone(),
            arguments: Value::String(arguments.clone()),
            index: *index,
        })
        .collect();
}

fn process_openai_payload(
    payload: Value,
    result: &mut ProviderResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
    sink: &EventSink,
    session: &Session,
    answer_started: &mut bool,
    suppress_output: bool,
) {
    if let Some(usage) = payload.get("usage") {
        result.prompt_tokens = usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .or(result.prompt_tokens);
        result.completion_tokens = usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .or(result.completion_tokens);
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|values| values.first());
    let Some(choice) = choice else { return };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        result.truncated_tool_arguments = true;
    }
    let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
        return;
    };
    emit_content(
        sink,
        session,
        result,
        text_content(delta.get("content")),
        answer_started,
        suppress_output,
    );
    let reasoning = text_content(delta.get("reasoning_content"))
        .or_else_nonempty(|| text_content(delta.get("reasoning")))
        .or_else_nonempty(|| text_content(delta.get("thinking")));
    emit_reasoning(sink, session, result, reasoning);
    append_openai_delta(result, delta, partial);
}

fn complete_utf8_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<Vec<String>, String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        lines.push(
            std::str::from_utf8(&line)
                .map_err(|_| "model stream contained invalid UTF-8".to_owned())?
                .to_owned(),
        );
    }
    Ok(lines)
}

fn normalize_tool_call_ids(calls: &mut [ToolCall]) {
    let mut used = HashSet::new();
    for (position, call) in calls.iter_mut().enumerate() {
        let base = if call.id.trim().is_empty() {
            format!("tool-call-{}", call.index)
        } else {
            call.id.trim().to_owned()
        };
        let mut candidate = base.clone();
        let mut suffix = position;
        while !used.insert(candidate.clone()) {
            suffix += 1;
            candidate = format!("{base}-{suffix}");
        }
        call.id = candidate;
    }
}

trait NonEmptyFallback {
    fn or_else_nonempty(self, fallback: impl FnOnce() -> String) -> String;
}
impl NonEmptyFallback for String {
    fn or_else_nonempty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() { fallback() } else { self }
    }
}

fn process_ollama_payload(
    payload: Value,
    result: &mut ProviderResult,
    sink: &EventSink,
    session: &Session,
    answer_started: &mut bool,
    suppress_output: bool,
) {
    result.prompt_tokens = payload
        .get("prompt_eval_count")
        .and_then(Value::as_u64)
        .or(result.prompt_tokens);
    result.completion_tokens = payload
        .get("eval_count")
        .and_then(Value::as_u64)
        .or(result.completion_tokens);
    let Some(message) = payload.get("message").and_then(Value::as_object) else {
        return;
    };
    emit_content(
        sink,
        session,
        result,
        text_content(message.get("content")),
        answer_started,
        suppress_output,
    );
    let reasoning = text_content(message.get("reasoning_content"))
        .or_else_nonempty(|| text_content(message.get("reasoning")))
        .or_else_nonempty(|| text_content(message.get("thinking")));
    emit_reasoning(sink, session, result, reasoning);
    for raw in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(call) = raw.as_object() else {
            continue;
        };
        let function = call
            .get("function")
            .and_then(Value::as_object)
            .unwrap_or(call);
        let arguments = function
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        result.tool_calls.push(ToolCall {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("tool-call-{}", result.tool_calls.len())),
            name: function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            arguments,
            index: result.tool_calls.len(),
        });
    }
}

fn encoded_messages(messages: &[Value], ollama: bool, veil: bool) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| !(veil && message.get("role").and_then(Value::as_str) == Some("system")))
        .map(|message| {
            if !ollama {
                return message.clone();
            }
            let mut value = message.clone();
            if let Some(object) = value.as_object_mut() {
                let content = match object.get("content") {
                    Some(Value::Array(_)) => text_content(object.get("content")),
                    Some(Value::Null) | None => String::new(),
                    Some(Value::String(value)) => value.clone(),
                    _ => String::new(),
                };
                object.insert("content".into(), Value::String(content));
            }
            value
        })
        .collect()
}

pub async fn stream_provider_chat(
    session: &Session,
    sink: &EventSink,
    messages: &[Value],
    tools: &[Value],
    include_tools: bool,
    require_tool_call: bool,
    suppress_output: bool,
) -> Result<ProviderResult, String> {
    if session.is_aborted() {
        return Err("model request aborted".into());
    }
    let (endpoint, host_header) = request_endpoint(&session.config.provider)?;
    let path = endpoint.path().trim_end_matches('/').to_ascii_lowercase();
    let ollama = path.ends_with("/api/chat")
        && !matches!(
            path.as_str(),
            "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
        );
    let veil = matches!(
        path.as_str(),
        "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
    );
    let mut body = json!({ "messages": encoded_messages(messages, ollama, veil), "stream": true });
    let object = body.as_object_mut().unwrap();
    if !veil {
        object.insert(
            "model".into(),
            Value::String(session.config.provider.model_id.clone()),
        );
    }
    if ollama {
        object.insert(
            "options".into(),
            json!({ "num_ctx": session.config.context_length }),
        );
    }
    if veil && !session.config.skills.is_empty() {
        object.insert("skills".into(), Value::Array(session.config.skills.iter().map(|skill| json!({ "id":skill.id, "name":skill.name, "description":skill.description, "source":skill.source })).collect()));
    }
    if include_tools && !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools.to_vec()));
        if !ollama {
            object.insert(
                "tool_choice".into(),
                Value::String(
                    if require_tool_call {
                        "required"
                    } else {
                        "auto"
                    }
                    .into(),
                ),
            );
        }
        if !ollama && !veil {
            object.insert("parallel_tool_calls".into(), Value::Bool(true));
        }
    }
    let client = client_for(&session.config.provider)?;
    let mut request = client
        .post(endpoint.clone())
        .header("Content-Type", "application/json");
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    if !session.config.provider.api_key.trim().is_empty() {
        request = request.bearer_auth(&session.config.provider.api_key);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("model request failed: {error}"))?;
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "model request failed: {} {}",
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        ));
    }
    let action = response
        .headers()
        .get("x-umbratic-action-required")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            matches!(
                *value,
                "change" | "execute" | "inspect" | "change-and-execute"
            )
        })
        .unwrap_or("")
        .to_owned();
    let mut result = ProviderResult {
        action_requirement: action,
        ..ProviderResult::default()
    };
    let mut partial = BTreeMap::new();
    let mut answer_started = false;
    let mut buffer = Vec::new();
    let mut completed = ollama;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if session.is_aborted() {
            return Err("model request aborted".into());
        }
        let chunk = chunk.map_err(|error| error.to_string())?;
        for line in complete_utf8_lines(&mut buffer, &chunk)? {
            if ollama {
                if let Ok(payload) = serde_json::from_str::<Value>(line.trim()) {
                    process_ollama_payload(
                        payload,
                        &mut result,
                        sink,
                        session,
                        &mut answer_started,
                        suppress_output,
                    );
                }
            } else if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    completed = true;
                    continue;
                }
                if let Ok(payload) = serde_json::from_str::<Value>(data) {
                    process_openai_payload(
                        payload,
                        &mut result,
                        &mut partial,
                        sink,
                        session,
                        &mut answer_started,
                        suppress_output,
                    );
                }
            }
        }
    }
    let trailing = std::str::from_utf8(&buffer)
        .map_err(|_| "model stream ended with invalid UTF-8".to_owned())?;
    if ollama
        && !trailing.trim().is_empty()
        && let Ok(payload) = serde_json::from_str::<Value>(trailing.trim())
    {
        process_ollama_payload(
            payload,
            &mut result,
            sink,
            session,
            &mut answer_started,
            suppress_output,
        );
    }
    if !completed {
        return Err("model stream ended before the completion marker".into());
    }
    normalize_tool_call_ids(&mut result.tool_calls);
    if result.truncated_tool_arguments {
        for call in &mut result.tool_calls {
            call.arguments = Value::String("{\"__umbratic_truncated_tool_arguments__\":".into());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MtlsConfig;
    #[test]
    fn tool_deltas_accumulate_by_index() {
        let mut result = ProviderResult::default();
        let mut calls = BTreeMap::new();
        append_openai_delta(&mut result, json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\"file"}}]}).as_object().unwrap(), &mut calls);
        append_openai_delta(
            &mut result,
            json!({"tool_calls":[{"index":0,"function":{"arguments":"Path\":\"README.md\"}"}}]})
                .as_object()
                .unwrap(),
            &mut calls,
        );
        assert_eq!(
            result.tool_calls[0].arguments.as_str(),
            Some("{\"filePath\":\"README.md\"}")
        );
    }
    #[test]
    fn certificate_fingerprints_normalize_common_notation() {
        let hex = "AB".repeat(32);
        assert_eq!(
            normalize_sha256_fingerprint(&format!("sha256/{hex}")),
            hex.to_lowercase()
        );
        assert_eq!(
            normalize_sha256_fingerprint(&format!(
                "sha256:{}",
                hex.as_bytes()
                    .chunks(2)
                    .map(|part| std::str::from_utf8(part).unwrap())
                    .collect::<Vec<_>>()
                    .join(":")
            )),
            hex.to_lowercase()
        );
    }

    #[test]
    fn split_multibyte_utf8_is_preserved_until_a_complete_line() {
        let source = "data: {\"choices\":[{\"delta\":{\"content\":\"café\"}}]}\n";
        let bytes = source.as_bytes();
        let split = source.find('é').unwrap() + 1;
        let mut buffer = Vec::new();
        assert!(
            complete_utf8_lines(&mut buffer, &bytes[..split])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            complete_utf8_lines(&mut buffer, &bytes[split..]).unwrap(),
            [source.trim_end()]
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn complete_stream_lines_reject_invalid_utf8() {
        let mut buffer = Vec::new();
        assert_eq!(
            complete_utf8_lines(&mut buffer, b"data: \xff\n").unwrap_err(),
            "model stream contained invalid UTF-8"
        );
    }

    #[test]
    fn duplicate_and_missing_tool_call_ids_are_made_unique() {
        let mut calls = vec![
            ToolCall {
                id: "same".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 0,
            },
            ToolCall {
                id: "same".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 1,
            },
            ToolCall {
                id: "".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 2,
            },
        ];
        normalize_tool_call_ids(&mut calls);
        assert_eq!(
            calls
                .iter()
                .map(|call| call.id.as_str())
                .collect::<Vec<_>>(),
            ["same", "same-2", "tool-call-2"]
        );
    }

    fn provider_with_mtls(mtls: MtlsConfig) -> ProviderConfig {
        ProviderConfig {
            id: "company-endpoint".into(),
            name: "test".into(),
            base_url: "https://127.0.0.1".into(),
            chat_endpoint_path: Some("/v1/chat/completions".into()),
            api_key: String::new(),
            model_id: "test".into(),
            headers: BTreeMap::new(),
            mtls: Some(mtls),
        }
    }

    #[test]
    fn mtls_pem_identity_requires_a_certificate_and_key_pair() {
        let cert_only = provider_with_mtls(MtlsConfig {
            cert_path: Some("client.pem".into()),
            ..MtlsConfig::default()
        });
        assert!(
            client_for(&cert_only)
                .unwrap_err()
                .contains("certPath and keyPath")
        );
    }
}
