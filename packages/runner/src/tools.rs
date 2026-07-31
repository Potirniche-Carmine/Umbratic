use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

use globset::GlobBuilder;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::{Duration, Instant as TokioInstant, interval, sleep_until},
};
use walkdir::WalkDir;

use crate::{
    config::PermissionMode,
    context::compress_tool_result,
    events::now_iso,
    policy::{
        confirm_workspace_write_path, is_blocked_path, is_generated_runtime_path,
        redact_stream_text, redact_text, resolve_workspace_path,
    },
    safety::{CommandPermit, SafetyAction, SafetyDecisionV1},
    session::{EventSink, Session},
};

mod coercion;
mod command;
#[cfg(test)]
mod command_tests;
mod contract;
mod dispatch;
mod error;
mod patch;
mod read;
mod request;
mod schema;
mod search;
mod skill;
mod skill_mention;
mod write;

pub(crate) use coercion::coerce_tool_call_arguments;
use command::command_tool;
#[cfg(test)]
use command::{
    filtered_command_environment, resolve_trusted_shell, safe_command_environment,
    trusted_command_path,
};
pub(crate) use contract::validate_tool_call_batch;
pub use dispatch::execute_tool;
pub use error::ToolResult;
use error::{ToolError, ToolExecutionResult};
use read::{read_attachment_tool, read_tool};
#[cfg(test)]
use request::parse_arguments;
pub use request::tool_capability_name;
use request::{ToolRequest, command_display};
pub use schema::enabled_tool_specs;
use search::search_tool;
#[cfg(test)]
use search::{parse_search_query, term_score};
use skill::read_skill_tool;
pub(crate) use skill_mention::explicit_skill_context;
#[cfg(test)]
use skill_mention::explicit_skill_mention;
use write::{edit_tool, write_tool};

const MAX_READ_OUTPUT_BYTES: usize = 60 * 1024;
const MAX_TEXT_FILE_BYTES: u64 = 512 * 1024;
const MAX_ATTACHMENT_CHUNK_BYTES: usize = 12 * 1024;
static RECENT_READS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub index: usize,
}

fn string_arg(input: &Map<String, Value>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| input.get(*name).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn string_list_arg(input: &Map<String, Value>, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .find_map(|name| input.get(*name))
        .map(|value| match value {
            Value::String(value) => vec![value.clone()],
            Value::Array(values) => values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        })
        .unwrap_or_default()
}

fn number_arg(input: &Map<String, Value>, name: &str, fallback: u64, max: u64) -> u64 {
    input
        .get(name)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(1, max)
}

fn ensure_text_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Path is not a file".into());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is too large to read through this tool".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Err("Refusing to read binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "Refusing to read non-UTF-8 file".into())
}

fn clip_read_output(output: String) -> String {
    if output.len() <= MAX_READ_OUTPUT_BYTES {
        return output;
    }
    let mut end = MAX_READ_OUTPUT_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1
    }
    format!(
        "{}\n...[truncated: read output exceeded {MAX_READ_OUTPUT_BYTES} bytes; use offset/limit to continue]",
        &output[..end]
    )
}

fn should_skip(relative: &str) -> bool {
    relative.is_empty() || is_generated_runtime_path(relative) || is_blocked_path(relative)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn workspace_command_environment_is_explicit_and_filters_credentials_case_insensitively() {
        let filtered = filtered_command_environment([
            ("PATH".into(), "/bin".into()),
            ("HOME".into(), "/home/test".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
            ("SystemDrive".into(), "C:".into()),
            ("provider_api_key".into(), "secret".into()),
            ("Authorization".into(), "Bearer secret".into()),
            ("SSH_AUTH_SOCK".into(), "/tmp/agent".into()),
            ("UMBRATIC_RUNNER_CONFIG".into(), "secret config".into()),
            ("UNRELATED".into(), "not forwarded".into()),
        ]);
        assert_eq!(filtered.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(filtered.get("HOME").map(String::as_str), Some("/home/test"));
        assert_eq!(filtered.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(filtered.get("SystemDrive").map(String::as_str), Some("C:"));
        assert_eq!(filtered.len(), 4);
    }

    #[test]
    fn command_children_use_trusted_shell_and_minimal_path() {
        let shell = resolve_trusted_shell().expect("trusted shell");
        assert!(
            shell.is_absolute(),
            "shell must be absolute: {}",
            shell.display()
        );
        assert!(shell.is_file(), "shell must exist: {}", shell.display());
        #[cfg(windows)]
        assert!(
            shell
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe"))
        );
        #[cfg(not(windows))]
        assert_eq!(shell.file_name().and_then(|name| name.to_str()), Some("sh"));

        let trusted = trusted_command_path();
        assert!(
            !trusted.contains(".umbratic"),
            "trusted PATH must not include workspace runtime: {trusted}"
        );
        #[cfg(windows)]
        assert!(
            trusted.to_ascii_lowercase().contains("system32"),
            "trusted Windows PATH should include System32: {trusted}"
        );
        #[cfg(not(windows))]
        assert!(
            trusted
                .split(':')
                .any(|entry| entry == "/usr/bin" || entry == "/bin"),
            "trusted Unix PATH should include system bins: {trusted}"
        );

        let env = safe_command_environment();
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some(trusted.as_str()),
            "command children must replace inherited PATH with the trusted minimal PATH"
        );
    }
    #[test]
    fn markdown_fenced_arguments_are_rejected() {
        let value = Value::String("```json\n{\"filePath\":\"README.md\"}\n```".into());
        assert!(parse_arguments(&value).is_err());
    }

    #[test]
    fn command_and_run_program_have_distinct_exact_shapes() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            ToolRequest::parse(
                "command",
                &json!({"args":["echo","unsafe implicit command"]}),
                directory.path(),
            )
            .unwrap_err()
            .contains("unknown argument args")
        );
        assert!(
            ToolRequest::parse("command", &json!({}), directory.path())
                .unwrap_err()
                .contains("missing a required string argument")
        );
        assert!(
            ToolRequest::parse(
                "run_program",
                &json!({"programId":"python","command":"python file.py"}),
                directory.path(),
            )
            .unwrap_err()
            .contains("unknown argument command")
        );
    }

    #[test]
    fn search_query_supports_constraints_globs_smart_case_and_locations() {
        let parsed = parse_search_query(
            "src/ src/**/*.tsx !test/ !*.min.js \"Button label\" service.ts:42:7",
        );
        assert_eq!(parsed.include_dirs, ["src/"]);
        assert_eq!(parsed.include_globs, ["src/**/*.tsx"]);
        assert_eq!(parsed.exclude_dirs, ["test/"]);
        assert_eq!(parsed.exclude_globs, ["*.min.js"]);
        assert_eq!(parsed.terms, ["Button label"]);
        assert_eq!(parsed.location.as_deref(), Some("service.ts"));
        assert!(parsed.smart_case);
        assert!(term_score("src/components/Button.ts", "Button.ts", "Buton.ts", false) > 0.0);
    }

    #[test]
    fn replace_text_accepts_read_output_line_endings_and_preserves_the_file_style() {
        let current = "before\r\n  <span>Auto-run low risk</span>\r\nafter\r\n";
        let old = "  <span>Auto-run low risk</span>\nafter";
        let new = "  <span className=\"safe\">Auto-run low risk</span>\nafter";
        let updated = patch::replace_text_block(current, old, new).unwrap();
        assert_eq!(
            updated,
            "before\r\n  <span className=\"safe\">Auto-run low risk</span>\r\nafter\r\n"
        );
    }

    #[test]
    fn only_declared_tool_names_map_to_runner_capabilities() {
        assert_eq!(tool_capability_name("search"), Some("search"));
        assert_eq!(tool_capability_name("apply_patch"), Some("edit"));
        assert_eq!(tool_capability_name("run_program"), Some("command"));
        for undeclared in ["search_files", "apply-patch", "ls", "PowerShell", "bash"] {
            assert_eq!(tool_capability_name(undeclared), None, "{undeclared}");
        }
    }

    #[test]
    fn explicit_skill_mentions_require_exact_token_boundaries() {
        assert!(explicit_skill_mention("Use $python for this.", "python"));
        assert!(explicit_skill_mention("$python", "python"));
        assert!(!explicit_skill_mention("Use $python-extra.", "python"));
        assert!(!explicit_skill_mention("email$python", "python"));
    }

    #[tokio::test]
    async fn tool_specs_offer_clear_replace_patch_and_scoped_search_shapes() {
        let directory = tempfile::tempdir().unwrap();
        let specs = enabled_tool_specs(&crate::session::test_session(directory.path()), true).await;
        let named = |name: &str| {
            specs
                .iter()
                .find(|spec| spec["function"]["name"] == name)
                .unwrap()
        };
        assert_eq!(
            named("edit")["function"]["parameters"]["required"],
            json!(["filePath", "oldText", "newText"])
        );
        assert_eq!(
            named("apply_patch")["function"]["parameters"]["required"],
            json!(["patch"])
        );
        assert!(named("search")["function"]["parameters"]["properties"]["path"].is_object());
        assert_eq!(
            named("search")["function"]["parameters"]["properties"]["queries"]["maxItems"],
            json!(32)
        );
        assert!(
            specs.iter().all(|spec| spec["function"]["name"] != "lsp"),
            "lsp must be omitted when no approved server is configured"
        );
        assert!(
            specs
                .iter()
                .all(|spec| spec["function"]["parameters"]["additionalProperties"] == json!(false))
        );
        assert_eq!(
            named("command")["function"]["parameters"]["required"],
            json!(["command"])
        );
    }

    #[tokio::test]
    async fn command_schemas_have_one_execution_mode_each() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("runtime");
        std::fs::write(&executable, "fixture").unwrap();
        let mut session = crate::session::test_session(directory.path());
        Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config)
            .unwrap()
            .approved_executables
            .extend([
                ("runtime".into(), executable.clone()),
                ("uv".into(), executable),
            ]);
        let specs = enabled_tool_specs(&session, true).await;
        let command = specs
            .iter()
            .find(|spec| spec["function"]["name"] == "command")
            .unwrap();
        assert_eq!(
            command["function"]["parameters"]["required"],
            json!(["command"])
        );
        assert!(command["function"]["parameters"]["properties"]["programId"].is_null());
        let program = specs
            .iter()
            .find(|spec| spec["function"]["name"] == "run_program")
            .unwrap();
        assert_eq!(
            program["function"]["parameters"]["required"],
            json!(["programId"])
        );
        assert!(program["function"]["parameters"]["properties"]["command"].is_null());
        assert!(
            program["function"]["description"]
                .as_str()
                .unwrap()
                .contains(r#"["run","python","path/to/script.py"]"#)
        );
    }

    #[tokio::test]
    async fn tool_batches_reject_undeclared_aliases_duplicates_and_wrong_fields() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let specs = enabled_tool_specs(&session, true).await;
        let call = |id: &str, name: &str, arguments: Value| ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            index: 0,
        };
        assert!(
            validate_tool_call_batch(
                &session,
                &[call("alias", "bash", json!({"command":"echo test"}))],
                &specs,
            )
            .unwrap_err()
            .contains("not declared")
        );
        assert!(
            validate_tool_call_batch(
                &session,
                &[
                    call("one", "read", json!({"filePath":"README.md"})),
                    call("two", "read", json!({"filePath":"README.md"})),
                ],
                &specs,
            )
            .unwrap_err()
            .contains("more than once")
        );
        assert!(
            validate_tool_call_batch(
                &session,
                &[call(
                    "mixed",
                    "command",
                    json!({"command":"echo test","programId":"python"}),
                )],
                &specs,
            )
            .unwrap_err()
            .contains("undeclared argument programId")
        );
        assert!(
            validate_tool_call_batch(
                &session,
                &[call(
                    "range",
                    "command",
                    json!({"command":"echo test","timeoutMs":99}),
                )],
                &specs,
            )
            .unwrap_err()
            .contains("below the declared minimum")
        );
    }

    #[tokio::test]
    async fn tool_argument_coercion_is_narrow_and_schema_driven() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let specs = enabled_tool_specs(&session, true).await;
        let call = |id: &str, name: &str, arguments: Value| ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            index: 0,
        };
        let mut calls = vec![
            call(
                "read",
                "read",
                json!({"filePath":["README.md"],"offset":"7"}),
            ),
            call(
                "search",
                "search",
                json!({"query":"needle","caseSensitive":"true"}),
            ),
            call(
                "double",
                "read",
                Value::String(
                    serde_json::to_string(
                        &serde_json::to_string(&json!({"filePath":"README.md"})).unwrap(),
                    )
                    .unwrap(),
                ),
            ),
        ];
        let changes = coerce_tool_call_arguments(&mut calls, &specs);
        assert_eq!(
            calls[0].arguments,
            json!({"filePath":"README.md","offset":7})
        );
        assert_eq!(calls[1].arguments["caseSensitive"], json!(true));
        assert_eq!(calls[2].arguments, json!({"filePath":"README.md"}));
        assert_eq!(changes.len(), 3);
        validate_tool_call_batch(&session, &calls, &specs).unwrap();

        let mut rejected = vec![call(
            "many",
            "read",
            json!({"filePath":["README.md","Cargo.toml"]}),
        )];
        assert!(coerce_tool_call_arguments(&mut rejected, &specs).is_empty());
        assert!(validate_tool_call_batch(&session, &rejected, &specs).is_err());
    }

    #[tokio::test]
    async fn exact_edit_contract_replaces_lf_text_in_a_crlf_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("main.tsx");
        std::fs::write(
            &target,
            "before\r\n  <span>Auto-run low risk</span>\r\nafter\r\n",
        )
        .unwrap();
        let result = execute_tool(
            crate::session::test_session(directory.path()),
            crate::session::test_sink(directory.path()),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "edit-exact".into(),
                name: "edit".into(),
                arguments: json!({
                    "filePath":"main.tsx",
                    "oldText":"  <span>Auto-run low risk</span>\nafter",
                    "newText":"  <span className=\"safe\">Auto-run low risk</span>\nafter"
                }),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert_eq!(
            std::fs::read_to_string(target).unwrap(),
            "before\r\n  <span className=\"safe\">Auto-run low risk</span>\r\nafter\r\n"
        );
    }

    #[tokio::test]
    async fn exact_search_contract_scopes_results_and_returns_editable_snippets() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("src/renderer")).unwrap();
        std::fs::create_dir_all(directory.path().join("other")).unwrap();
        std::fs::write(
            directory.path().join("src/renderer/main.tsx"),
            "<span>Auto-run low risk</span>\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("other/main.tsx"),
            "<span>Auto-run low risk</span>\n",
        )
        .unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let result = execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "search-exact".into(),
                name: "search".into(),
                arguments: json!({
                    "query":"Auto-run low risk",
                    "path":"src/renderer",
                    "glob":"*.tsx",
                    "limit":10
                }),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert!(
            result
                .output
                .contains("src/renderer/main.tsx:1: <span>Auto-run low risk</span>")
        );
        assert!(!result.output.contains("other/main.tsx"));
        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        let finished = observed
            .iter()
            .find(|event| event["type"] == "tool.finished")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!finished.contains_key("errorCode"));
        assert!(!finished.contains_key("errorMessage"));
        assert!(!finished.contains_key("response"));
    }

    #[tokio::test]
    async fn search_matches_terms_across_a_file_and_missing_reads_suggest_exact_paths() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("internal/auth")).unwrap();
        std::fs::write(
            directory.path().join("internal/auth/auth.go"),
            "package auth\n\nfunc loginHandler() {}\nfunc verifyPassword() {}\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("internal/auth/auth_test.go"),
            "package auth\n",
        )
        .unwrap();
        let session = crate::session::test_session(directory.path());
        let search = search_tool(
            &session,
            json!({"query":"login password","path":"internal/auth"})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(search.output.contains("internal/auth/auth.go:3:"));
        assert!(search.output.contains("internal/auth/auth.go:4:"));

        let missing = read_tool(
            &session,
            json!({"filePath":"internal/auth/password.go"})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap_err();
        assert!(
            missing
                .message
                .contains("Path not found: internal/auth/password.go")
        );
        assert!(missing.message.contains("internal/auth/auth.go"));
        assert!(
            !missing
                .message
                .contains(directory.path().to_string_lossy().as_ref())
        );
        #[cfg(windows)]
        assert!(!missing.message.contains(":/"));

        let empty = search_tool(
            &session,
            json!({"query":"missing impossible symbol"})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(empty.output.contains("Use only exact result paths"));
    }

    #[tokio::test]
    async fn invalid_calls_still_emit_one_requested_and_one_finished_event() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let result = execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "bad-call".into(),
                name: "read".into(),
                arguments: Value::String("not-json".into()),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "validation_error");
        assert_eq!(result.error_code.as_deref(), Some("invalid_arguments"));

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(
            observed
                .iter()
                .filter(|event| event["type"] == "tool.requested")
                .count(),
            1
        );
        assert_eq!(
            observed
                .iter()
                .filter(|event| event["type"] == "tool.finished")
                .count(),
            1
        );
        let policy = observed
            .iter()
            .find(|event| event["type"] == "tool.policy.stage")
            .unwrap();
        assert_eq!(policy["outcome"], "blocked");
        assert_eq!(policy["reason"], "invalid_arguments");
    }

    #[tokio::test]
    async fn disabled_and_aborted_calls_keep_complete_lifecycles() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.enabled_tools.clear();
        let session = Arc::new(Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            durable_summary: tokio::sync::Mutex::new(None),
            failed_compaction_digest: tokio::sync::Mutex::new(None),
            compaction_count: std::sync::atomic::AtomicU32::new(0),
            context_calibration: tokio::sync::Mutex::new(None),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            lsp: None,
            workspace_graph: None,
            turn: std::sync::Mutex::new(None),
        });
        let permissions = Arc::new(crate::permission::PermissionBroker::default());
        for (id, expected) in [("disabled", "tool_disabled"), ("aborted", "aborted")] {
            let sink = crate::session::test_sink(directory.path());
            let mut events = sink.subscribe();
            let _turn = if id == "aborted" {
                let turn = session.try_begin_turn().expect("active turn for abort");
                session.abort();
                Some(turn)
            } else {
                None
            };
            let result = execute_tool(
                session.clone(),
                sink,
                permissions.clone(),
                ToolCall {
                    id: id.into(),
                    name: "read".into(),
                    arguments: json!({"filePath":"README.md"}),
                    index: 0,
                },
            )
            .await;
            assert_eq!(result.error_code.as_deref(), Some(expected));
            let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(observed.first().unwrap()["type"], "tool.requested");
            assert_eq!(
                observed.first().unwrap()["arguments"]["filePath"],
                "README.md"
            );
            assert_eq!(observed.last().unwrap()["type"], "tool.finished");
            assert!(observed.last().unwrap()["response"].as_str().is_some());
            assert_eq!(
                observed
                    .iter()
                    .filter(|event| event["type"] == "tool.finished")
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn patch_mode_adds_updates_moves_and_deletes_atomically() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source.txt"), "before\n").unwrap();
        std::fs::write(directory.path().join("delete.txt"), "remove\n").unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let result = execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "patch".into(),
                name: "apply_patch".into(),
                arguments: json!({"patch":"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Add File: added.txt\n+new file\n*** End Patch"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert!(!directory.path().join("source.txt").exists());
        assert!(!directory.path().join("delete.txt").exists());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("moved.txt")).unwrap(),
            "after\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("added.txt")).unwrap(),
            "new file"
        );
    }

    #[tokio::test]
    async fn read_rejects_paths_outside_the_workspace() {
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(parent.path().join("secret.txt"), "TOP_SECRET_CONTENT").unwrap();
        let result = execute_tool(
            crate::session::test_session(&workspace),
            crate::session::test_sink(&workspace),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "escape".into(),
                name: "read".into(),
                arguments: json!({"filePath":"../secret.txt"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "policy_blocked");
        assert!(!result.output.contains("TOP_SECRET_CONTENT"));
    }

    #[tokio::test]
    async fn attachment_reader_retrieves_every_utf8_byte_and_rejects_escape_paths() {
        let workspace = tempfile::tempdir().unwrap();
        let attachments = tempfile::tempdir().unwrap();
        let content = format!("BEGIN\n{}\nEND", "中🙂 attachment content ".repeat(120));
        std::fs::write(attachments.path().join("plan.md"), &content).unwrap();
        let mut config = (*crate::session::test_config(workspace.path())).clone();
        config.attachment_directory = Some(attachments.path().to_path_buf());
        let session = Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            durable_summary: tokio::sync::Mutex::new(None),
            failed_compaction_digest: tokio::sync::Mutex::new(None),
            compaction_count: std::sync::atomic::AtomicU32::new(0),
            context_calibration: tokio::sync::Mutex::new(None),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            lsp: None,
            workspace_graph: None,
            turn: std::sync::Mutex::new(None),
        };

        let specs = enabled_tool_specs(&session, true).await;
        assert!(
            specs
                .iter()
                .any(|spec| spec["function"]["name"] == "read_attachment")
        );

        let mut offset = 0usize;
        let mut reconstructed = String::new();
        loop {
            let args = json!({"attachmentId":"plan.md","offset":offset,"limit":31})
                .as_object()
                .unwrap()
                .clone();
            let result = read_attachment_tool(&session, &args).unwrap();
            let (_, chunk) = result.output.split_once("\n\n").unwrap();
            reconstructed.push_str(chunk);
            let Some(next) = result
                .output
                .lines()
                .find_map(|line| line.strip_prefix("Read status: partial; continue with offset "))
            else {
                assert!(result.output.contains("Read status: complete"));
                break;
            };
            let next = next.parse::<usize>().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(reconstructed, content);

        for invalid in ["../plan.md", "nested/plan.md", ".."] {
            let args = json!({"attachmentId":invalid}).as_object().unwrap().clone();
            assert!(read_attachment_tool(&session, &args).is_err());
        }
    }

    #[tokio::test]
    async fn unavailable_program_ids_fail_before_requesting_user_permission() {
        let directory = tempfile::tempdir().unwrap();
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let result = execute_tool(
            crate::session::test_session(directory.path()),
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "missing-program".into(),
                name: "run_program".into(),
                arguments: json!({"programId":"npm","args":["run","test:all"]}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "policy_blocked");
        assert_eq!(
            result.error_message.as_deref(),
            Some("Executable npm is not available. Use only a programId declared by run_program.")
        );
        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert!(
            observed
                .iter()
                .all(|event| event["type"] != "permission.requested")
        );
    }

    #[tokio::test]
    async fn read_skill_is_limited_to_enabled_skill_resources() {
        let directory = tempfile::tempdir().unwrap();
        let skill_root = directory.path().join("skill");
        std::fs::create_dir(&skill_root).unwrap();
        let skill_path = skill_root.join("SKILL.md");
        std::fs::write(&skill_path, "main instructions").unwrap();
        std::fs::write(skill_root.join("reference.md"), "reference body").unwrap();
        std::fs::write(directory.path().join("secret.txt"), "TOP_SECRET_SKILL").unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.skills.push(crate::config::RunnerSkillConfig {
            id: "test-skill".into(),
            name: "Test".into(),
            description: String::new(),
            source: "local".into(),
            instruction_path: skill_path,
            paths: Vec::new(),
        });
        let session = Arc::new(Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            durable_summary: tokio::sync::Mutex::new(None),
            failed_compaction_digest: tokio::sync::Mutex::new(None),
            compaction_count: std::sync::atomic::AtomicU32::new(0),
            context_calibration: tokio::sync::Mutex::new(None),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            lsp: None,
            workspace_graph: None,
            turn: std::sync::Mutex::new(None),
        });
        let permissions = Arc::new(crate::permission::PermissionBroker::default());
        let allowed = execute_tool(
            session.clone(),
            crate::session::test_sink(directory.path()),
            permissions.clone(),
            ToolCall {
                id: "allowed".into(),
                name: "read_skill".into(),
                arguments: json!({"skillId":"test-skill","resource":"reference.md","limit":100}),
                index: 0,
            },
        )
        .await;
        assert_eq!(allowed.status, "success");
        assert!(allowed.output.contains("reference body"));

        let blocked = execute_tool(
            session,
            crate::session::test_sink(directory.path()),
            permissions,
            ToolCall {
                id: "blocked".into(),
                name: "read_skill".into(),
                arguments: json!({"skillId":"test-skill","resource":"../secret.txt"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(blocked.status, "policy_blocked");
        assert!(!blocked.output.contains("TOP_SECRET_SKILL"));
    }
}
