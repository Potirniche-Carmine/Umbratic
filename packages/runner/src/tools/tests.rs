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
    let surface = tool_surface(&crate::session::test_session(directory.path()));
    let violation = |name: &str, arguments: Value| {
        ToolRequest::parse(name, &arguments, directory.path(), surface.as_ref()).unwrap_err()
    };

    let args_on_command = violation(
        "command",
        json!({"args":["echo","unsafe implicit command"]}),
    );
    assert_eq!(args_on_command.field.as_deref(), Some("args"));
    assert_eq!(args_on_command.expected, "a declared field");

    let missing_command = violation("command", json!({}));
    assert_eq!(missing_command.field.as_deref(), Some("command"));
    assert_eq!(missing_command.expected, "a required value");

    // run_program is not on this surface: no executable is approved in a test
    // session, so the call is rejected as disabled rather than reaching field
    // checking at all.
    let run_program_disabled = violation(
        "run_program",
        json!({"programId":"python","command":"python file.py"}),
    );
    assert_eq!(run_program_disabled.code, "tool_disabled");
}

#[test]
fn replace_text_requires_exact_unique_matches() {
    let current = "before\r\n  <span>Auto-run low risk</span>\r\nafter\r\n";
    let old = "  <span>Auto-run low risk</span>\r\nafter";
    let new = "  <span className=\"safe\">Auto-run low risk</span>\r\nafter";
    let updated = patch::replace_unique_hunk(current, old, new).unwrap();
    assert_eq!(
        updated,
        "before\r\n  <span className=\"safe\">Auto-run low risk</span>\r\nafter\r\n"
    );
    assert!(patch::replace_unique_hunk("a\na\n", "a", "b").is_err());
}

#[test]
fn only_declared_tool_names_map_to_runner_capabilities() {
    assert_eq!(tool_capability_name("ls"), Some("ls"));
    assert_eq!(tool_capability_name("find"), Some("find"));
    assert_eq!(tool_capability_name("apply_patch"), Some("edit"));
    assert_eq!(tool_capability_name("run_program"), Some("command"));
    assert_eq!(tool_capability_name("search"), Some("search"));
    for undeclared in ["search_files", "apply-patch", "PowerShell", "bash"] {
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
async fn tool_specs_offer_clear_replace_patch_and_readonly_shapes() {
    let directory = tempfile::tempdir().unwrap();
    let specs = enabled_tool_specs(&crate::session::test_session(directory.path()), true);
    let named = |name: &str| {
        specs
            .iter()
            .find(|spec| spec["function"]["name"] == name)
            .unwrap()
    };
    assert_eq!(
        named("edit")["function"]["parameters"]["required"],
        json!(["path", "edits"])
    );
    assert_eq!(
        named("edit")["function"]["parameters"]["properties"]["edits"]["minItems"],
        json!(1)
    );
    assert!(named("edit")["function"]["parameters"]["properties"]["oldText"].is_null());
    assert!(named("edit")["function"]["parameters"]["properties"]["newText"].is_null());
    assert_eq!(
        named("apply_patch")["function"]["parameters"]["required"],
        json!(["patch"])
    );
    assert_eq!(
        named("read")["function"]["parameters"]["properties"]["offset"]["minimum"],
        json!(1)
    );
    assert!(named("read")["function"]["parameters"]["properties"]["depth"].is_null());
    assert_eq!(
        named("ls")["function"]["parameters"]["required"],
        json!(["path"])
    );
    assert_eq!(
        named("find")["function"]["parameters"]["required"],
        json!(["path", "glob"])
    );
    assert_eq!(
        named("search")["function"]["parameters"]["required"],
        json!(["query", "mode", "path"])
    );
    assert_eq!(
        named("search")["function"]["parameters"]["properties"]["mode"]["enum"],
        json!(["path", "content", "regex"])
    );
    // `search` absorbed the regex escape hatch, so no second text-search tool
    // is declared alongside it.
    assert!(
        specs.iter().all(|spec| spec["function"]["name"] != "grep"),
        "grep must not be declared; search mode regex replaced it"
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
    let specs = enabled_tool_specs(&session, true);
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
        )
        .unwrap_err()
        .message()
        .contains("a tool declared for this task")
    );
    let alias_error = validate_tool_call_batch(
        &session,
        &[call("alias-path", "read", json!({"filePath":"README.md"}))],
    )
    .unwrap_err()
    .message();
    assert!(
        alias_error.contains("filePath") || alias_error.contains("path"),
        "{alias_error}"
    );
    assert!(
        validate_tool_call_batch(
            &session,
            &[
                call("one", "read", json!({"path":"README.md"})),
                call("two", "read", json!({"path":"README.md"})),
            ],
        )
        .unwrap_err()
        .message()
        .contains("no repeated read call")
    );
    assert!(
        validate_tool_call_batch(
            &session,
            &[call(
                "mixed",
                "command",
                json!({"command":"echo test","programId":"python"}),
            )],
        )
        .unwrap_err()
        .message()
        .contains("programId")
    );
    assert!(
        validate_tool_call_batch(
            &session,
            &[call(
                "range",
                "command",
                json!({"command":"echo test","timeoutMs":99}),
            )],
        )
        .unwrap_err()
        .message()
        .contains("between 100 and 1800000")
    );
}

#[tokio::test]
async fn tool_argument_aliases_and_coercion_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let call = |id: &str, name: &str, arguments: Value| ToolCall {
        id: id.into(),
        name: name.into(),
        arguments,
        index: 0,
    };
    assert!(
        validate_tool_call_batch(
            &session,
            &[call("alias", "read", json!({"filePath":"README.md"}),)],
        )
        .is_err()
    );
    assert!(
        validate_tool_call_batch(
            &session,
            &[call(
                "coerced",
                "read",
                json!({"path":["README.md"],"offset":"7"}),
            )],
        )
        .is_err()
    );
}

#[tokio::test]
async fn exact_edit_contract_applies_unique_edits_and_rejects_ambiguity() {
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
                "path":"main.tsx",
                "edits":[{
                    "oldText":"  <span>Auto-run low risk</span>\r\nafter",
                    "newText":"  <span className=\"safe\">Auto-run low risk</span>\r\nafter"
                }]
            }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success", "{:?}", result.error_message);
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|value| value.get("firstChangedLine"))
            .and_then(Value::as_u64),
        Some(2)
    );
    assert!(result.content.contains("--- a/main.tsx"));
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "before\r\n  <span className=\"safe\">Auto-run low risk</span>\r\nafter\r\n"
    );

    std::fs::write(&target, "alpha\nalpha\n").unwrap();
    let ambiguous = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "edit-ambiguous".into(),
            name: "edit".into(),
            arguments: json!({
                "path":"main.tsx",
                "edits":[{"oldText":"alpha","newText":"beta"}]
            }),
            index: 0,
        },
    )
    .await;
    assert_eq!(ambiguous.status, "validation_error");
    assert_eq!(ambiguous.code.as_deref(), Some("edit_ambiguous"));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "alpha\nalpha\n");
}

#[tokio::test]
async fn write_reports_created_or_replaced_effects() {
    let directory = tempfile::tempdir().unwrap();
    let create = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "write-create".into(),
            name: "write".into(),
            arguments: json!({"path":"nested/note.txt","content":"one\n"}),
            index: 0,
        },
    )
    .await;
    assert_eq!(create.status, "success", "{:?}", create.error_message);
    assert_eq!(
        create
            .details
            .as_ref()
            .and_then(|value| value.get("effect"))
            .and_then(Value::as_str),
        Some("created")
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("nested/note.txt")).unwrap(),
        "one\n"
    );

    let replace = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "write-replace".into(),
            name: "write".into(),
            arguments: json!({"path":"nested/note.txt","content":"two\n"}),
            index: 0,
        },
    )
    .await;
    assert_eq!(replace.status, "success", "{:?}", replace.error_message);
    assert_eq!(
        replace
            .details
            .as_ref()
            .and_then(|value| value.get("effect"))
            .and_then(Value::as_str),
        Some("replaced")
    );
}

#[tokio::test]
async fn read_returns_raw_text_and_missing_paths_suggest_exact_entries() {
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
    let read = read_tool(
        &session,
        json!({"path":"internal/auth/auth.go","offset":3,"limit":1})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(read.content, "func loginHandler() {}");
    assert!(!read.content.contains("3:"));
    assert_eq!(
        read.continuation
            .as_ref()
            .and_then(|value| value.get("nextOffset"))
            .and_then(Value::as_u64),
        Some(4)
    );

    let located = search_tool(
        session.clone(),
        json!({"query":"loginHandler","mode":"content","path":"internal/auth"})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(located.content.contains("internal/auth/auth.go:3:"));

    let missing = read_tool(
        &session,
        json!({"path":"internal/auth/password.go"})
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
    // The listing is stated as the complete set and the next guess is closed
    // off: a live run answered this message with four more invented siblings.
    assert!(
        missing.message.contains("contains exactly these 2 entries"),
        "{}",
        missing.message
    );
    assert!(
        missing.message.contains("Do not guess another name"),
        "{}",
        missing.message
    );
    assert!(
        !missing
            .message
            .contains(directory.path().to_string_lossy().as_ref())
    );
    #[cfg(windows)]
    assert!(!missing.message.contains(":/"));

    let listed = ls_tool(
        &session,
        json!({"path":"internal/auth"}).as_object().unwrap(),
    )
    .await
    .unwrap();
    assert!(listed.content.contains("auth.go"));
    assert!(listed.content.contains("auth_test.go"));
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
    assert_eq!(result.code.as_deref(), Some("invalid_arguments"));

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
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
    });
    let permissions = Arc::new(crate::permission::PermissionBroker::default());
    for (id, expected) in [("disabled", "tool_disabled"), ("aborted", "aborted")] {
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let _run = if id == "aborted" {
            let run = session.try_begin_run().expect("active run for abort");
            session.abort();
            Some(run)
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
                arguments: json!({"path":"README.md"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.code.as_deref(), Some(expected));
        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(observed.first().unwrap()["type"], "tool.requested");
        assert_eq!(observed.first().unwrap()["arguments"]["path"], "README.md");
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
            arguments: json!({"path":"../secret.txt"}),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "policy_blocked");
    assert!(!result.content.contains("TOP_SECRET_CONTENT"));
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
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
    };

    let specs = enabled_tool_specs(&session, true);
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
        let (_, chunk) = result.content.split_once("\n\n").unwrap();
        reconstructed.push_str(chunk);
        let Some(next) = result
            .content
            .lines()
            .find_map(|line| line.strip_prefix("Read status: partial; continue with offset "))
        else {
            assert!(result.content.contains("Read status: complete"));
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
    // With no approved executable, run_program is never on the frozen surface, so
    // the call is rejected as an undeclared tool before any permission request.
    assert_eq!(result.status, "validation_error");
    assert_eq!(result.code.as_deref(), Some("tool_disabled"));
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
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
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
    assert!(allowed.content.contains("reference body"));

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
    assert!(!blocked.content.contains("TOP_SECRET_SKILL"));
}
