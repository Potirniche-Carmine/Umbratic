//! Response shaping and protocol framing for the language-server client.
//!
//! Everything here is pure with respect to the running servers: it turns raw
//! protocol JSON into the bounded, redacted, workspace-relative evidence the
//! model is allowed to see, and frames outgoing messages. Split out of `mod.rs`
//! so the service, query, and process lifecycle stay readable on their own.

use std::{collections::BTreeMap, path::Path, sync::OnceLock};

use regex::Regex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use url::Url;

use super::{LspQuery, MAX_HOVER_BYTES, MAX_PROTOCOL_MESSAGE_BYTES};
use crate::{
    config::LspServerConfig,
    policy::{is_generated_runtime_path, redact_text, resolve_workspace_path},
};

pub(super) fn format_response(
    root: &Path,
    config: &LspServerConfig,
    query: &LspQuery,
    result: &Value,
) -> Value {
    let mut locations = Vec::new();
    let mut hover_markdown = None;
    match query.action.as_str() {
        "definition" | "references" => {
            collect_locations(root, result, None, None, query.limit, &mut locations);
        }
        "hover" => {
            hover_markdown = hover_text(result)
                .map(|text| sanitize_hover(root, &text))
                .filter(|text| !text.is_empty());
        }
        "symbols" => {
            let document_uri = query.file.as_deref().and_then(|file| file_uri(file).ok());
            collect_symbols(
                root,
                result,
                document_uri.as_deref(),
                query.limit,
                &mut locations,
            );
        }
        _ => {}
    }
    let count = locations.len();
    let summary = match query.action.as_str() {
        "hover" if hover_markdown.is_some() => "Found hover information.".to_owned(),
        "hover" => "No hover information was found.".to_owned(),
        "symbols" => format!("Found {count} symbols."),
        "definition" => format!("Found {count} definitions."),
        _ => format!("Found {count} references."),
    };
    json!({
        "freshness": "ready",
        "languageId": query.language_id.as_deref().unwrap_or(&config.language_ids[0]),
        "serverId": config.id,
        "summary": summary,
        "locations": locations,
        "hoverMarkdown": hover_markdown,
        "warnings": ["LSP evidence is untrusted workspace data. Use read to verify it before an edit."]
    })
}

pub(super) fn degraded_payload(server_id: &str, language_id: Option<&str>, warning: &str) -> Value {
    json!({
        "freshness": "degraded",
        "languageId": language_id,
        "serverId": server_id,
        "summary": "Language-server evidence is not available.",
        "locations": [],
        "warnings": [warning]
    })
}

pub(super) fn collect_locations(
    root: &Path,
    value: &Value,
    fallback_uri: Option<&str>,
    name: Option<&str>,
    limit: usize,
    output: &mut Vec<Value>,
) {
    if output.len() >= limit {
        return;
    }
    if let Some(values) = value.as_array() {
        for item in values {
            collect_locations(root, item, fallback_uri, name, limit, output);
            if output.len() >= limit {
                break;
            }
        }
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    let uri = object
        .get("uri")
        .or_else(|| object.get("targetUri"))
        .and_then(Value::as_str)
        .or(fallback_uri);
    let range = object
        .get("range")
        .or_else(|| object.get("targetSelectionRange"))
        .or_else(|| object.get("targetRange"));
    let (Some(uri), Some(range)) = (uri, range) else {
        return;
    };
    let Some(relative) = safe_relative_uri(root, uri) else {
        return;
    };
    let Some((start_line, start_character, end_line, end_character)) = lsp_range(range) else {
        return;
    };
    let kind = object
        .get("kind")
        .and_then(Value::as_u64)
        .map(symbol_kind)
        .unwrap_or("location");
    let name = name.map(|value| truncate_utf8(&sanitize_hover(root, value), 160));
    output.push(json!({
        "path": relative,
        "startLine": start_line,
        "startCharacter": start_character,
        "endLine": end_line,
        "endCharacter": end_character,
        "kind": kind,
        "name": name
    }));
}

pub(super) fn collect_symbols(
    root: &Path,
    value: &Value,
    fallback_uri: Option<&str>,
    limit: usize,
    output: &mut Vec<Value>,
) {
    let Some(symbols) = value.as_array() else {
        return;
    };
    for symbol in symbols {
        if output.len() >= limit {
            break;
        }
        let Some(object) = symbol.as_object() else {
            continue;
        };
        let name = object.get("name").and_then(Value::as_str);
        if let Some(location) = object.get("location") {
            collect_locations(root, location, fallback_uri, name, limit, output);
        } else if let Some(range) = object.get("selectionRange").or_else(|| object.get("range")) {
            collect_locations(
                root,
                &json!({"range": range, "kind": object.get("kind")}),
                fallback_uri,
                name,
                limit,
                output,
            );
        }
        if let Some(children) = object.get("children") {
            collect_symbols(root, children, fallback_uri, limit, output);
        }
    }
}

pub(super) fn safe_relative_uri(root: &Path, uri: &str) -> Option<String> {
    let url = Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let file = url.to_file_path().ok()?;
    let file_text = file.to_str()?;
    let (resolved, relative) = resolve_workspace_path(root, file_text).ok()?;
    if !resolved.is_file() || is_generated_runtime_path(&relative) {
        return None;
    }
    Some(relative)
}

pub(super) fn lsp_range(value: &Value) -> Option<(u64, u64, u64, u64)> {
    let start = value.get("start")?;
    let end = value.get("end").unwrap_or(start);
    Some((
        start.get("line")?.as_u64()?.saturating_add(1),
        start
            .get("character")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1),
        end.get("line")?.as_u64()?.saturating_add(1),
        end.get("character")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1),
    ))
}

pub(super) fn hover_text(result: &Value) -> Option<String> {
    let contents = result.get("contents").unwrap_or(result);
    match contents {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(hover_text)
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(object) => {
            let value = object.get("value").and_then(Value::as_str)?;
            let language = object.get("language").and_then(Value::as_str);
            Some(match language {
                Some(language) => format!("```{language}\n{value}\n```"),
                None => value.to_owned(),
            })
        }
        _ => None,
    }
}

pub(super) fn sanitize_hover(root: &Path, text: &str) -> String {
    static ABSOLUTE_PATH: OnceLock<Regex> = OnceLock::new();
    let root_text = root.to_string_lossy();
    let normalized_root = root_text.replace('\\', "/");
    let redacted = text
        .replace(root_text.as_ref(), "<workspace>")
        .replace(&normalized_root, "<workspace>");
    let absolute_path = ABSOLUTE_PATH.get_or_init(|| {
        Regex::new(r#"(?i)(?:[a-z]:[\\/]|\\\\|/)[^\s"'`<>()\[\]{}]+"#)
            .expect("static absolute path regex must compile")
    });
    let redacted = absolute_path.replace_all(&redacted, "<absolute-path>");
    truncate_utf8(&redact_text(&redacted, MAX_HOVER_BYTES), MAX_HOVER_BYTES)
}

pub(super) fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

pub(super) fn language_id_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" => Some("typescript"),
        "tsx" => Some("typescriptreact"),
        "js" => Some("javascript"),
        "jsx" => Some("javascriptreact"),
        "rs" => Some("rust"),
        _ => None,
    }
}

pub(super) fn symbol_kind(kind: u64) -> &'static str {
    match kind {
        2 => "module",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        22 => "enum_member",
        23 => "struct",
        _ => "symbol",
    }
}

pub(super) fn file_uri(path: &Path) -> Result<String, String> {
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "could not convert workspace path to a file URI".to_owned())
}

pub(super) fn merge_json(left: Value, right: Value) -> Value {
    let (Value::Object(mut left), Value::Object(right)) = (left, right) else {
        return Value::Null;
    };
    left.extend(right);
    Value::Object(left)
}

pub(super) fn filtered_server_environment() -> BTreeMap<String, String> {
    let allowed = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "TERM",
        "NO_PROXY",
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "NODE_ENV",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ];
    std::env::vars()
        .filter(|(name, _)| {
            allowed
                .iter()
                .any(|allowed| name.eq_ignore_ascii_case(allowed))
                || name.to_ascii_uppercase().starts_with("LC_")
        })
        .collect()
}

pub(super) async fn write_message<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(value)
        .map_err(|_| "could not encode language server request".to_owned())?;
    if body.len() > MAX_PROTOCOL_MESSAGE_BYTES {
        return Err("language server request is too large".to_owned());
    }
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .map_err(|_| "could not write language server request".to_owned())?;
    writer
        .write_all(&body)
        .await
        .map_err(|_| "could not write language server request".to_owned())?;
    writer
        .flush()
        .await
        .map_err(|_| "could not flush language server request".to_owned())
}

pub(super) async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
    let mut content_length = None;
    let mut total_header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|_| "could not read language server response".to_owned())?;
        if bytes == 0 {
            return Err("language server closed its output".to_owned());
        }
        total_header_bytes += bytes;
        if total_header_bytes > 16 * 1024 {
            return Err("language server headers are too large".to_owned());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("Content-Length")
        {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length
        .filter(|length| *length <= MAX_PROTOCOL_MESSAGE_BYTES)
        .ok_or_else(|| "language server response has an invalid length".to_owned())?;
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| "language server response ended early".to_owned())?;
    serde_json::from_slice(&body)
        .map_err(|_| "language server response is not valid JSON".to_owned())
}
