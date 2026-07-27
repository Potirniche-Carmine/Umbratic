use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
};

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::{Duration, interval, sleep, timeout},
};
use url::Url;

use crate::{
    config::LspServerConfig,
    policy::{is_generated_runtime_path, redact_text, resolve_workspace_path},
    session::Session,
};

const MAX_PROTOCOL_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HOVER_BYTES: usize = 8 * 1024;
const MAX_LOCATIONS: usize = 40;
const MAX_SYMBOLS: usize = 50;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
const SHORT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const LONG_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct LspService {
    root: PathBuf,
    slots: Arc<Vec<ServerSlot>>,
}

struct ServerSlot {
    config: LspServerConfig,
    state: Mutex<ServerState>,
}

enum ServerState {
    New,
    Ready(Box<LspProcess>),
    Degraded,
}

struct LspProcess {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    opened_documents: HashMap<PathBuf, OpenDocument>,
    workspace_folder: Value,
}

struct OpenDocument {
    version: i64,
    text: String,
}

struct LspQuery {
    action: String,
    file: Option<PathBuf>,
    language_id: Option<String>,
    line: u64,
    character: u64,
    query: String,
    limit: usize,
}

impl LspService {
    pub fn new(root: PathBuf, servers: Vec<LspServerConfig>) -> Self {
        Self {
            root,
            slots: Arc::new(
                servers
                    .into_iter()
                    .take(3)
                    .map(|config| ServerSlot {
                        config,
                        state: Mutex::new(ServerState::New),
                    })
                    .collect(),
            ),
        }
    }

    pub async fn query(
        &self,
        input: &Map<String, Value>,
        session: &Session,
    ) -> Result<Value, String> {
        let query = LspQuery::parse(&self.root, input)?;
        let slot = self
            .select_server(&query)
            .ok_or_else(|| "No approved language server supports this request.".to_owned())?;
        let server_id = slot.config.id.clone();
        let mut state = slot.state.lock().await;
        if matches!(*state, ServerState::New) {
            *state = match LspProcess::start(&self.root, &slot.config, session).await {
                Ok(process) => ServerState::Ready(Box::new(process)),
                Err(_) => ServerState::Degraded,
            };
        }
        let ServerState::Ready(process) = &mut *state else {
            return Ok(degraded_payload(
                &server_id,
                query.language_id.as_deref(),
                "The language server is unavailable for this session.",
            ));
        };
        match process
            .execute(&self.root, &slot.config, &query, session)
            .await
        {
            Ok(result) => Ok(result),
            Err(_) => {
                *state = ServerState::Degraded;
                Ok(degraded_payload(
                    &server_id,
                    query.language_id.as_deref(),
                    "The language server stopped or did not respond in time.",
                ))
            }
        }
    }

    fn select_server(&self, query: &LspQuery) -> Option<&ServerSlot> {
        if let Some(file) = query.file.as_ref() {
            let extension = file
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            return self.slots.iter().find(|slot| {
                slot.config
                    .extensions
                    .iter()
                    .any(|candidate| candidate == &extension)
            });
        }
        self.slots.first()
    }

    pub async fn shutdown(&self) {
        for slot in self.slots.iter() {
            let mut state = slot.state.lock().await;
            if let ServerState::Ready(process) = &mut *state {
                process.shutdown().await;
            }
            *state = ServerState::Degraded;
        }
    }
}

impl LspQuery {
    fn parse(root: &Path, input: &Map<String, Value>) -> Result<Self, String> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !matches!(
            action.as_str(),
            "definition" | "references" | "hover" | "symbols"
        ) {
            return Err("lsp action must be definition, references, hover, or symbols.".to_owned());
        }
        let file_text = input
            .get("filePath")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if action != "symbols" && file_text.is_none() {
            return Err("lsp requires filePath for this action.".to_owned());
        }
        let (file, language_id) = if let Some(file_text) = file_text {
            let (absolute, relative) = resolve_workspace_path(root, file_text)?;
            if !absolute.is_file() {
                return Err("lsp filePath must identify an existing file.".to_owned());
            }
            if is_generated_runtime_path(&relative) {
                return Err("lsp refuses generated runtime paths.".to_owned());
            }
            let metadata = std::fs::metadata(&absolute)
                .map_err(|_| "lsp could not inspect the requested file.".to_owned())?;
            if metadata.len() > MAX_DOCUMENT_BYTES {
                return Err("lsp file exceeds the 2 MiB document limit.".to_owned());
            }
            let language_id = language_id_for_path(&absolute).map(str::to_owned);
            (Some(absolute), language_id)
        } else {
            (None, None)
        };
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .chars()
            .take(256)
            .collect::<String>();
        if action == "symbols" && file.is_none() && query.is_empty() {
            return Err("lsp workspace symbols require query.".to_owned());
        }
        for name in ["line", "character", "limit"] {
            if input.contains_key(name)
                && input
                    .get(name)
                    .and_then(Value::as_u64)
                    .is_none_or(|value| value == 0)
            {
                return Err(format!("lsp {name} must be a positive integer."));
            }
        }
        let default_limit = if action == "symbols" {
            MAX_SYMBOLS
        } else {
            MAX_LOCATIONS
        };
        let max_limit = default_limit;
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(default_limit as u64)
            .clamp(1, max_limit as u64) as usize;
        Ok(Self {
            action,
            file,
            language_id,
            line: input
                .get("line")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1),
            character: input
                .get("character")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1),
            query,
            limit,
        })
    }
}

impl LspProcess {
    async fn start(
        root: &Path,
        config: &LspServerConfig,
        session: &Session,
    ) -> Result<Self, String> {
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .current_dir(root)
            .env_clear()
            .envs(filtered_server_environment())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "language server could not start".to_owned())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "language server stdin is unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .map(BufReader::new)
            .ok_or_else(|| "language server stdout is unavailable".to_owned())?;
        let root_uri = file_uri(root)?;
        let mut process = Self {
            _child: child,
            stdin,
            stdout,
            next_id: 1,
            opened_documents: HashMap::new(),
            workspace_folder: json!({
                "uri": root_uri.clone(),
                "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("workspace")
            }),
        };
        process
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "rootUri": root_uri,
                    "workspaceFolders": [process.workspace_folder.clone()],
                    "capabilities": {
                        "textDocument": {
                            "definition": {"linkSupport": true},
                            "hover": {"contentFormat": ["markdown", "plaintext"]},
                            "references": {}
                        },
                        "workspace": {"symbol": {"resolveSupport": {"properties": ["location.range"]}}}
                    },
                    "clientInfo": {"name": "UmbraticRunner", "version": crate::RUNNER_VERSION}
                }),
                INITIALIZE_TIMEOUT,
                Some(session),
            )
            .await?;
        process.notify("initialized", json!({})).await?;
        Ok(process)
    }

    async fn execute(
        &mut self,
        root: &Path,
        config: &LspServerConfig,
        query: &LspQuery,
        session: &Session,
    ) -> Result<Value, String> {
        let result = match query.action.as_str() {
            "definition" | "references" | "hover" => {
                let file = query.file.as_ref().expect("validated LSP file");
                let language_id = query
                    .language_id
                    .as_deref()
                    .filter(|language| config.language_ids.iter().any(|id| id == language))
                    .unwrap_or(&config.language_ids[0]);
                self.open_document(file, language_id).await?;
                let uri = file_uri(file)?;
                let position = json!({
                    "textDocument": {"uri": uri},
                    "position": {
                        "line": query.line.saturating_sub(1),
                        "character": query.character.saturating_sub(1)
                    }
                });
                let (method, params, request_timeout) = match query.action.as_str() {
                    "definition" => ("textDocument/definition", position, SHORT_REQUEST_TIMEOUT),
                    "references" => (
                        "textDocument/references",
                        merge_json(position, json!({"context": {"includeDeclaration": true}})),
                        LONG_REQUEST_TIMEOUT,
                    ),
                    _ => ("textDocument/hover", position, SHORT_REQUEST_TIMEOUT),
                };
                self.request(method, params, request_timeout, Some(session))
                    .await?
            }
            "symbols" => {
                if let Some(file) = query.file.as_ref() {
                    let language_id = query
                        .language_id
                        .as_deref()
                        .filter(|language| config.language_ids.iter().any(|id| id == language))
                        .unwrap_or(&config.language_ids[0]);
                    self.open_document(file, language_id).await?;
                    self.request(
                        "textDocument/documentSymbol",
                        json!({"textDocument": {"uri": file_uri(file)?}}),
                        LONG_REQUEST_TIMEOUT,
                        Some(session),
                    )
                    .await?
                } else {
                    self.request(
                        "workspace/symbol",
                        json!({"query": query.query}),
                        LONG_REQUEST_TIMEOUT,
                        Some(session),
                    )
                    .await?
                }
            }
            _ => return Err("unsupported LSP action".to_owned()),
        };
        Ok(format_response(root, config, query, &result))
    }

    async fn open_document(&mut self, file: &Path, language_id: &str) -> Result<(), String> {
        let text = tokio::fs::read_to_string(file)
            .await
            .map_err(|_| "language server document must be UTF-8 text".to_owned())?;
        let uri = file_uri(file)?;
        if let Some(opened) = self.opened_documents.get_mut(file) {
            if opened.text == text {
                return Ok(());
            }
            opened.version += 1;
            opened.text.clone_from(&text);
            let version = opened.version;
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": version},
                    "contentChanges": [{"text": text}]
                }),
            )
            .await
        } else {
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": 1,
                        "text": text
                    }
                }),
            )
            .await?;
            self.opened_documents
                .insert(file.to_path_buf(), OpenDocument { version: 1, text });
            Ok(())
        }
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        request_timeout: Duration,
        session: Option<&Session>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        write_message(
            &mut self.stdin,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )
        .await?;
        let (result, must_cancel) = {
            let response = self.read_response(id);
            tokio::pin!(response);
            let deadline = sleep(request_timeout);
            tokio::pin!(deadline);
            let mut abort_poll = interval(Duration::from_millis(25));
            loop {
                tokio::select! {
                    result = &mut response => break (result, false),
                    _ = &mut deadline => break (Err("language server request timed out".to_owned()), true),
                    _ = abort_poll.tick(), if session.is_some() => {
                        if session.is_some_and(Session::is_aborted) {
                            break (Err("language server request was aborted".to_owned()), true);
                        }
                    }
                }
            }
        };
        if must_cancel {
            let _ = self.notify("$/cancelRequest", json!({"id": id})).await;
        }
        result
    }

    async fn read_response(&mut self, id: u64) -> Result<Value, String> {
        for _ in 0..512 {
            let message = read_message(&mut self.stdout).await?;
            if message.get("method").and_then(Value::as_str).is_some()
                && let Some(request_id) = message.get("id").cloned()
            {
                let result = if message.get("method").and_then(Value::as_str)
                    == Some("workspace/configuration")
                {
                    let count = message
                        .pointer("/params/items")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0);
                    Value::Array(vec![Value::Null; count])
                } else if message.get("method").and_then(Value::as_str)
                    == Some("workspace/workspaceFolders")
                {
                    Value::Array(vec![self.workspace_folder.clone()])
                } else if message.get("method").and_then(Value::as_str)
                    == Some("workspace/applyEdit")
                {
                    json!({"applied": false})
                } else {
                    Value::Null
                };
                write_message(
                    &mut self.stdin,
                    &json!({"jsonrpc":"2.0","id":request_id,"result":result}),
                )
                .await?;
                continue;
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if message.get("error").is_some_and(|error| !error.is_null()) {
                return Err("language server returned an error".to_owned());
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
        Err("language server sent too many unrelated messages".to_owned())
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        write_message(
            &mut self.stdin,
            &json!({"jsonrpc": "2.0", "method": method, "params": params}),
        )
        .await
    }

    async fn shutdown(&mut self) {
        let _ = self
            .request("shutdown", Value::Null, Duration::from_secs(2), None)
            .await;
        let _ = self.notify("exit", Value::Null).await;
        if timeout(Duration::from_secs(2), self._child.wait())
            .await
            .is_err()
        {
            let _ = self._child.start_kill();
            let _ = timeout(Duration::from_secs(2), self._child.wait()).await;
        }
    }
}

fn format_response(
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
        "schemaVersion": 1,
        "freshness": "ready",
        "languageId": query.language_id.as_deref().unwrap_or(&config.language_ids[0]),
        "serverId": config.id,
        "summary": summary,
        "locations": locations,
        "hoverMarkdown": hover_markdown,
        "warnings": ["LSP evidence is untrusted workspace data. Use read to verify it before an edit."]
    })
}

fn degraded_payload(server_id: &str, language_id: Option<&str>, warning: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "freshness": "degraded",
        "languageId": language_id,
        "serverId": server_id,
        "summary": "Language-server evidence is not available.",
        "locations": [],
        "warnings": [warning]
    })
}

fn collect_locations(
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

fn collect_symbols(
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

fn safe_relative_uri(root: &Path, uri: &str) -> Option<String> {
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

fn lsp_range(value: &Value) -> Option<(u64, u64, u64, u64)> {
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

fn hover_text(result: &Value) -> Option<String> {
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

fn sanitize_hover(root: &Path, text: &str) -> String {
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

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn language_id_for_path(path: &Path) -> Option<&'static str> {
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

fn symbol_kind(kind: u64) -> &'static str {
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

fn file_uri(path: &Path) -> Result<String, String> {
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "could not convert workspace path to a file URI".to_owned())
}

fn merge_json(left: Value, right: Value) -> Value {
    let (Value::Object(mut left), Value::Object(right)) = (left, right) else {
        return Value::Null;
    };
    left.extend(right);
    Value::Object(left)
}

fn filtered_server_environment() -> BTreeMap<String, String> {
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

async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<(), String> {
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

async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{BufReader, duplex};

    #[test]
    fn language_ids_cover_the_first_release_floor() {
        assert_eq!(
            language_id_for_path(Path::new("src/main.ts")),
            Some("typescript")
        );
        assert_eq!(
            language_id_for_path(Path::new("src/View.tsx")),
            Some("typescriptreact")
        );
        assert_eq!(language_id_for_path(Path::new("src/lib.rs")), Some("rust"));
        assert_eq!(language_id_for_path(Path::new("src/main.py")), None);
    }

    #[test]
    fn hover_output_is_bounded_and_removes_the_workspace_root() {
        let root = Path::new("/private/workspace");
        let input = format!(
            "{}\n/other/private/file.ts\nC:\\private\\file.ts\n{}",
            root.display(),
            "x".repeat(MAX_HOVER_BYTES + 100)
        );
        let output = sanitize_hover(root, &input);
        assert!(!output.contains("/private/workspace"));
        assert!(!output.contains("/other/private/file.ts"));
        assert!(!output.contains("C:\\private\\file.ts"));
        assert!(output.len() <= MAX_HOVER_BYTES + '…'.len_utf8());
    }

    #[tokio::test]
    async fn protocol_framing_handles_notifications_before_a_response() {
        let (mut client, server) = duplex(4096);
        let mut reader = BufReader::new(server);
        let notification = json!({"jsonrpc":"2.0","method":"window/logMessage","params":{}});
        let response = json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
        write_message(&mut client, &notification).await.unwrap();
        write_message(&mut client, &response).await.unwrap();
        assert_eq!(read_message(&mut reader).await.unwrap(), notification);
        assert_eq!(read_message(&mut reader).await.unwrap(), response);
    }

    #[test]
    fn outside_root_and_blocked_server_locations_are_removed() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("main.ts"), "export const x = 1;").unwrap();
        std::fs::write(workspace.path().join(".env"), "TOKEN=secret").unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let value = json!([
            {
                "uri": file_uri(&workspace.path().join("main.ts")).unwrap(),
                "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":6}}
            },
            {
                "uri": file_uri(outside.path()).unwrap(),
                "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":6}}
            },
            {
                "uri": file_uri(&workspace.path().join(".env")).unwrap(),
                "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":6}}
            }
        ]);
        let mut locations = Vec::new();
        collect_locations(
            workspace.path(),
            &value,
            None,
            None,
            MAX_LOCATIONS,
            &mut locations,
        );
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0]["path"], "main.ts");
    }

    #[test]
    fn query_validation_rejects_bad_actions_positions_and_paths() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("main.ts"), "export const x = 1;").unwrap();
        let valid = json!({
            "action": "definition",
            "filePath": "main.ts",
            "line": 1,
            "character": 1
        });
        assert!(LspQuery::parse(workspace.path(), valid.as_object().unwrap()).is_ok());
        for invalid in [
            json!({"action":"rename","filePath":"main.ts"}),
            json!({"action":"definition","filePath":"main.ts","line":0}),
            json!({"action":"definition","filePath":"../outside.ts"}),
            json!({"action":"symbols","query":""}),
        ] {
            assert!(
                LspQuery::parse(workspace.path(), invalid.as_object().unwrap()).is_err(),
                "{invalid}"
            );
        }
    }
}
