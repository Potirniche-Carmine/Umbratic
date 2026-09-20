use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde_json::{Map, Value, json};
use tokio::{
    io::BufReader,
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::{Duration, interval, sleep, timeout},
};

use crate::{
    config::LspServerConfig,
    policy::{is_generated_runtime_path, resolve_workspace_path},
    session::Session,
    tools::catalog::MAX_LSP_RESULTS,
};

const MAX_PROTOCOL_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HOVER_BYTES: usize = 8 * 1024;
const MAX_RESULTS: usize = MAX_LSP_RESULTS as usize;
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
        futures_util::future::join_all(self.slots.iter().map(|slot| async {
            let mut state = slot.state.lock().await;
            let previous = std::mem::replace(&mut *state, ServerState::Degraded);
            drop(state);
            if let ServerState::Ready(mut process) = previous {
                // The owned process is kill-on-drop if even its exit write
                // stalls. Every slot drains concurrently within this bound.
                let _ = timeout(Duration::from_secs(6), process.shutdown()).await;
            }
        }))
        .await;
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
        let file_text = input
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if action != "symbols" && file_text.is_none() {
            return Err("lsp requires path for this action.".to_owned());
        }
        let (file, language_id) = if let Some(file_text) = file_text {
            let (absolute, relative) = resolve_workspace_path(root, file_text)?;
            if !absolute.is_file() {
                return Err("lsp path must identify an existing file.".to_owned());
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
        // The catalog validates action against its enum and line, character, and
        // limit against their declared ranges before dispatch. What is left here
        // is what the catalog cannot know: whether the path resolves, whether the
        // file is readable, and whether the action has the arguments it needs.
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_RESULTS as u64) as usize;
        Ok(Self {
            action,
            file,
            language_id,
            line: input.get("line").and_then(Value::as_u64).unwrap_or(1),
            character: input.get("character").and_then(Value::as_u64).unwrap_or(1),
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

mod shaping;

use shaping::*;

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
            MAX_RESULTS,
            &mut locations,
        );
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0]["path"], "main.ts");
    }

    #[test]
    fn query_validation_rejects_what_the_catalog_cannot_check() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("main.ts"), "export const x = 1;").unwrap();
        let valid = json!({
            "action": "definition",
            "path": "main.ts",
            "line": 1,
            "character": 1
        });
        assert!(LspQuery::parse(workspace.path(), valid.as_object().unwrap()).is_ok());
        // The action enum and the one-based line and character ranges are the
        // catalog's to enforce, and it does so before dispatch. What is left here
        // needs the filesystem or the shape of the whole call.
        for invalid in [
            json!({"action":"definition","path":"../outside.ts"}),
            json!({"action":"definition","path":"missing.ts"}),
            json!({"action":"definition"}),
            json!({"action":"symbols","query":""}),
        ] {
            assert!(
                LspQuery::parse(workspace.path(), invalid.as_object().unwrap()).is_err(),
                "{invalid}"
            );
        }
    }
}
