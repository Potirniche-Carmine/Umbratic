use std::{
    collections::{BTreeMap, HashSet},
    fs,
    net::ToSocketAddrs,
    sync::OnceLock,
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

fn provider_bearer(provider: &ProviderConfig) -> String {
    provider
        .api_key
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

static SHARED_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static SHARED_HTTP_CLIENT_ERROR: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Default)]
pub struct VeilChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub action_requirement: String,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub truncated_tool_arguments: bool,
}

pub struct VeilRequestOptions {
    pub max_output_tokens: u64,
    pub include_tools: bool,
    pub require_tool_call: bool,
    pub suppress_output: bool,
}

pub async fn compact_context(
    session: &Session,
    previous_summary: Option<&str>,
    messages: &[Value],
    source_digest: &str,
    max_summary_tokens: u64,
) -> Result<String, String> {
    let (mut endpoint, host_header) = request_endpoint(&session.config.provider)?;
    endpoint.set_path("/api/internal/context/compact");
    endpoint.set_query(None);
    let route = session
        .config
        .provider
        .chat_endpoint_path
        .as_deref()
        .and_then(|path| path.split('/').nth(2))
        .unwrap_or("engineering");
    let body = json!({
        "version": 1,
        "route": route,
        "previousSummary": previous_summary.unwrap_or(""),
        "messages": messages,
        "maxSummaryTokens": max_summary_tokens.min(4_096),
        "sourceDigest": source_digest,
    });
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json");
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("context compaction failed: {error}"))?;
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("context compaction failed: {error}"))?;
    if bytes.len() > 64 * 1024 {
        return Err("context compaction returned an oversized response".into());
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "context compaction returned invalid JSON".to_owned())?;
    if !status.is_success() {
        let code = payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("context_compaction_failed");
        return Err(code.to_owned());
    }
    if payload.get("version").and_then(Value::as_u64) != Some(1)
        || payload.get("sourceDigest").and_then(Value::as_str) != Some(source_digest)
    {
        return Err("context compaction response did not match its source".into());
    }
    payload
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "context compaction response did not contain a summary".to_owned())
}

fn shared_client(provider: &ProviderConfig) -> Result<Client, String> {
    if let Some(client) = SHARED_HTTP_CLIENT.get() {
        return Ok(client.clone());
    }
    if let Some(error) = SHARED_HTTP_CLIENT_ERROR.get() {
        return Err(error.clone());
    }
    match client_for(provider) {
        Ok(client) => {
            let _ = SHARED_HTTP_CLIENT.set(client.clone());
            Ok(client)
        }
        Err(error) => {
            let _ = SHARED_HTTP_CLIENT_ERROR.set(error.clone());
            Err(error)
        }
    }
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

fn append_content(result: &mut VeilChatResult, text: String) {
    if text.is_empty() {
        return;
    }
    result.content.push_str(&text);
}

fn bounded_progress(value: &str) -> String {
    const MAX_PROGRESS_BYTES: usize = 2 * 1024;
    if value.len() <= MAX_PROGRESS_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_PROGRESS_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", value[..end].trim_end())
}

fn emit_completed_output(
    sink: &EventSink,
    session: &Session,
    result: &VeilChatResult,
    suppress_output: bool,
    answer_streamed: bool,
) {
    if suppress_output || result.content.is_empty() {
        return;
    }
    if result.tool_calls.is_empty() && !answer_streamed {
        sink.emit(json!({ "type": "assistant.answer.started", "taskId": session.task_id, "at": now_iso() }));
        sink.emit(json!({ "type": "assistant.delta", "taskId": session.task_id, "text": result.content, "at": now_iso() }));
    } else if !result.tool_calls.is_empty() && !answer_streamed {
        sink.emit(json!({
            "type": "assistant.progress.delta",
            "taskId": session.task_id,
            "text": bounded_progress(&result.content),
            "at": now_iso()
        }));
    }
}

fn append_veil_delta(
    result: &mut VeilChatResult,
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

fn process_veil_payload(
    payload: Value,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> String {
    if let Some(usage) = payload.get("usage") {
        update_usage(result, usage);
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|values| values.first());
    let Some(choice) = choice else {
        return String::new();
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        result.truncated_tool_arguments = true;
    }
    let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
        return String::new();
    };
    let content = text_content(delta.get("content"));
    append_content(result, content.clone());
    append_veil_delta(result, delta, partial);
    content
}

fn update_usage(result: &mut VeilChatResult, usage: &Value) {
    let total = usage.get("total_tokens").and_then(Value::as_u64);
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            total
                .zip(result.completion_tokens)
                .map(|(total, completion)| total.saturating_sub(completion))
        });
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            total
                .zip(prompt.or(result.prompt_tokens))
                .map(|(total, prompt)| total.saturating_sub(prompt))
        });
    result.prompt_tokens = prompt.or(result.prompt_tokens);
    result.completion_tokens = completion.or(result.completion_tokens);
}

fn complete_utf8_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<Vec<String>, String> {
    const MAX_STREAM_LINE_BYTES: usize = 4 * 1024 * 1024;
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > MAX_STREAM_LINE_BYTES {
            return Err("model stream line exceeded the 4 MiB limit".into());
        }
        lines.push(
            std::str::from_utf8(&line)
                .map_err(|_| "model stream contained invalid UTF-8".to_owned())?
                .to_owned(),
        );
    }
    if buffer.len() > MAX_STREAM_LINE_BYTES {
        return Err("model stream line exceeded the 4 MiB limit".into());
    }
    Ok(lines)
}

fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:")
        .map(|data| data.strip_prefix(' ').unwrap_or(data))
}

fn veil_failure_message(status: Option<u16>, payload: Option<&Value>) -> String {
    let code = payload
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let upstream_status = payload
        .and_then(|value| value.get("upstreamStatus"))
        .and_then(Value::as_u64)
        .filter(|value| *value <= u16::MAX as u64);
    let description = match code {
        "model_service_rejected" => "the model service rejected the request",
        "model_service_timeout" => "the model service timed out",
        "model_service_invalid_response" => "the model service returned an invalid response",
        "model_service_stream_incomplete" => "the model service stream ended unexpectedly",
        "model_service_unavailable" => "the model service could not be reached",
        "context_overflow_preflight" => "context_overflow_preflight",
        "context_overflow_upstream" => "context_overflow_upstream",
        _ => "Veil could not complete the model request",
    };
    let mut details = Vec::new();
    if let Some(upstream_status) = upstream_status {
        details.push(format!("upstream status {upstream_status}"));
    }
    if let Some(status) = status {
        details.push(format!("Veil status {status}"));
    }
    if details.is_empty() {
        description.to_owned()
    } else {
        format!("{description} ({})", details.join(", "))
    }
}

fn veil_stream_error(line: &str) -> Option<String> {
    let data = sse_data(line)?;
    let payload = serde_json::from_str::<Value>(data).ok()?;
    payload.get("error")?;
    Some(format!(
        "model request failed: {}",
        veil_failure_message(None, Some(&payload))
    ))
}

fn process_veil_line(
    line: &str,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> Result<(bool, String), String> {
    let Some(data) = sse_data(line) else {
        return Ok((false, String::new()));
    };
    if data.trim() == "[DONE]" {
        return Ok((true, String::new()));
    }
    let payload = serde_json::from_str::<Value>(data)
        .map_err(|_| "Veil stream contained invalid JSON".to_owned())?;
    let content = process_veil_payload(payload, result, partial);
    Ok((false, content))
}

fn emit_answer_delta(sink: &EventSink, session: &Session, text: &str, answer_started: &mut bool) {
    if text.is_empty() {
        return;
    }
    if !*answer_started {
        sink.emit(json!({
            "type": "assistant.answer.started",
            "taskId": session.task_id,
            "at": now_iso()
        }));
        *answer_started = true;
    }
    sink.emit(json!({
        "type": "assistant.delta",
        "taskId": session.task_id,
        "text": text,
        "at": now_iso()
    }));
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

fn encoded_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .cloned()
        .collect()
}

pub async fn stream_veil_chat(
    session: &Session,
    sink: &EventSink,
    messages: &[Value],
    tools: &[Value],
    options: VeilRequestOptions,
) -> Result<VeilChatResult, String> {
    let VeilRequestOptions {
        max_output_tokens,
        include_tools,
        require_tool_call,
        suppress_output,
    } = options;
    if session.is_aborted() {
        return Err("model request aborted".into());
    }
    let (endpoint, host_header) = request_endpoint(&session.config.provider)?;
    let path = endpoint.path().trim_end_matches('/').to_ascii_lowercase();
    if !matches!(
        path.as_str(),
        "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
    ) {
        return Err("model request must target an approved Veil chat route".into());
    }
    let mut body = json!({
        "messages": encoded_messages(messages),
        "stream": true,
        "max_output_tokens": max_output_tokens
    });
    let object = body.as_object_mut().unwrap();
    if !session.config.skills.is_empty() {
        object.insert("skills".into(), Value::Array(session.config.skills.iter().map(|skill| json!({ "id":skill.id, "name":skill.name, "description":skill.description, "source":skill.source })).collect()));
    }
    if include_tools && !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools.to_vec()));
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
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint.clone())
        .header("Content-Type", "application/json");
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let send_future = request.json(&body).send();
    tokio::pin!(send_future);
    let response = loop {
        if session.is_aborted() {
            return Err("model request aborted".into());
        }
        tokio::select! {
            result = &mut send_future => {
                break result.map_err(|error| format!("model request failed: {error}"))?;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    };
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let payload = serde_json::from_str::<Value>(&text).ok();
        return Err(format!(
            "model request failed: {}",
            veil_failure_message(Some(status.as_u16()), payload.as_ref())
        ));
    }
    if response
        .headers()
        .get("x-umbratic-stream-version")
        .and_then(|value| value.to_str().ok())
        != Some("2")
    {
        return Err("Veil stream contract version 2 is required".into());
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
    let stream_answer = !suppress_output && (action.is_empty() || !include_tools);
    let mut result = VeilChatResult {
        action_requirement: action,
        ..VeilChatResult::default()
    };
    let mut partial = BTreeMap::new();
    let mut buffer = Vec::new();
    let mut completed = false;
    // Veil classifies workspace actions before it starts the response body. A
    // response with no required workspace action is a direct answer, so its
    // public content can reach the desktop as each validated SSE delta arrives.
    // Tool-required turns remain buffered until their tool-call shape is known.
    let mut answer_started = false;
    let mut stream = response.bytes_stream();
    loop {
        if session.is_aborted() {
            return Err("model request aborted".into());
        }
        let chunk =
            match tokio::time::timeout(std::time::Duration::from_millis(25), stream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => continue,
            };
        let chunk = chunk.map_err(|error| error.to_string())?;
        for line in complete_utf8_lines(&mut buffer, &chunk)? {
            if let Some(error) = veil_stream_error(&line) {
                return Err(error);
            }
            let (line_completed, content) = process_veil_line(&line, &mut result, &mut partial)?;
            if stream_answer {
                emit_answer_delta(sink, session, &content, &mut answer_started);
            }
            if line_completed {
                completed = true;
            }
        }
    }
    let trailing = std::str::from_utf8(&buffer)
        .map_err(|_| "model stream ended with invalid UTF-8".to_owned())?;
    if !trailing.trim().is_empty() {
        let trailing = trailing.trim_end_matches(['\r', '\n']);
        if let Some(error) = veil_stream_error(trailing) {
            return Err(error);
        }
        let (line_completed, content) = process_veil_line(trailing, &mut result, &mut partial)?;
        if stream_answer {
            emit_answer_delta(sink, session, &content, &mut answer_started);
        }
        if line_completed {
            completed = true;
        }
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
    emit_completed_output(sink, session, &result, suppress_output, answer_started);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MtlsConfig;
    #[test]
    fn tool_deltas_accumulate_by_index() {
        let mut result = VeilChatResult::default();
        let mut calls = BTreeMap::new();
        append_veil_delta(&mut result, json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\"file"}}]}).as_object().unwrap(), &mut calls);
        append_veil_delta(
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
    fn sse_data_accepts_optional_space_after_field_name() {
        assert_eq!(sse_data("data: [DONE]"), Some("[DONE]"));
        assert_eq!(sse_data("data:[DONE]"), Some("[DONE]"));
        assert_eq!(sse_data("event: error"), None);
    }

    #[test]
    fn veil_failures_are_specific_without_echoing_untrusted_response_bodies() {
        let payload = json!({
            "error": "provider leaked prompt content",
            "code": "model_service_rejected",
            "upstreamStatus": 500
        });
        let message = veil_failure_message(Some(502), Some(&payload));
        assert_eq!(
            message,
            "the model service rejected the request (upstream status 500, Veil status 502)"
        );
        assert!(!message.contains("leaked"));

        let stream =
            "data: {\"error\":\"hidden detail\",\"code\":\"model_service_stream_incomplete\"}";
        assert_eq!(
            veil_stream_error(stream).as_deref(),
            Some("model request failed: the model service stream ended unexpectedly")
        );
    }

    #[test]
    fn total_only_usage_completes_a_partial_provider_measurement() {
        let mut result = VeilChatResult {
            prompt_tokens: Some(1200),
            ..VeilChatResult::default()
        };
        update_usage(&mut result, &json!({"total_tokens": 1300}));
        assert_eq!(result.prompt_tokens, Some(1200));
        assert_eq!(result.completion_tokens, Some(100));

        let mut result = VeilChatResult {
            completion_tokens: Some(100),
            ..VeilChatResult::default()
        };
        update_usage(&mut result, &json!({"total_tokens": 1300}));
        assert_eq!(result.prompt_tokens, Some(1200));
        assert_eq!(result.completion_tokens, Some(100));
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
    fn stream_lines_and_json_are_bounded_and_strict() {
        let mut buffer = Vec::new();
        assert!(
            complete_utf8_lines(&mut buffer, &vec![b'x'; 4 * 1024 * 1024 + 1])
                .unwrap_err()
                .contains("4 MiB")
        );
        buffer.clear();
        let mut complete_oversized = vec![b'x'; 4 * 1024 * 1024 + 1];
        complete_oversized.push(b'\n');
        assert!(
            complete_utf8_lines(&mut buffer, &complete_oversized)
                .unwrap_err()
                .contains("4 MiB")
        );
        let mut result = VeilChatResult::default();
        let mut partial = BTreeMap::new();
        assert_eq!(
            process_veil_line("data: not-json", &mut result, &mut partial).unwrap_err(),
            "Veil stream contained invalid JSON"
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
            api_key: std::sync::Arc::new(std::sync::RwLock::new(String::new())),
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
