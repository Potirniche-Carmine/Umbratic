//! Contract-level tests: byte-exact read/edit round trips, the frozen tool
//! surface, and the generated validator end to end.

use std::sync::Arc;

use super::*;

#[tokio::test]
async fn read_output_feeds_a_byte_exact_edit_on_every_line_ending_style() {
    // Gate A: a model must be able to copy read output straight into
    // edits[].oldText and have the edit commit byte-exactly.
    let cases: [(&str, &str); 4] = [
        ("lf.txt", "alpha\nbravo\ncharlie\ndelta\n"),
        ("crlf.txt", "alpha\r\nbravo\r\ncharlie\r\ndelta\r\n"),
        ("mixed.txt", "alpha\r\nbravo\ncharlie\r\ndelta\n"),
        ("bom.txt", "\u{feff}alpha\r\nbravo\r\ncharlie\r\ndelta"),
    ];
    for (name, original) in cases {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join(name);
        std::fs::write(&target, original).unwrap();
        let session = crate::session::test_session(directory.path());

        let read = read_tool(
            &session,
            json!({"path": name, "offset": 2, "limit": 2})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(
            original.contains(&read.content),
            "{name}: read output {:?} is not an exact slice of the file",
            read.content
        );

        let replacement = read.content.replace("bravo", "BRAVO");
        let result = execute_tool(
            session,
            crate::session::test_sink(directory.path()),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "roundtrip".into(),
                name: "edit".into(),
                arguments: json!({
                    "path": name,
                    "edits": [{"oldText": read.content, "newText": replacement}],
                }),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "success", "{name}: {}", result.content);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            original.replace("bravo", "BRAVO"),
            "{name}: committed bytes diverged from the expected result"
        );
    }
}

#[tokio::test]
async fn apply_patch_matches_crlf_hunks_with_the_same_policy_as_edit() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("crlf.txt");
    std::fs::write(&target, "alpha\r\nbravo\r\ncharlie\r\n").unwrap();
    let patch = "*** Begin Patch\r\n*** Update File: crlf.txt\r\n@@\r\n alpha\r\n-bravo\r\n+BRAVO\r\n charlie\r\n*** End Patch\r\n";
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "patch-crlf".into(),
            name: "apply_patch".into(),
            arguments: json!({ "patch": patch }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "alpha\r\nBRAVO\r\ncharlie\r\n"
    );
}

#[tokio::test]
async fn the_tool_surface_is_frozen_for_the_task() {
    // Gate A: the schemas presented on step N are byte-identical to step 1, even
    // as session state that used to be consulted per turn changes underneath.
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let first = serde_json::to_string(&enabled_tool_specs(&session, true)).unwrap();

    // retrieve_context used to appear only once the store held something.
    {
        let mut store = session.context_store.lock().await;
        store
            .store(
                "call-1",
                "command",
                "command output",
                &"x".repeat(4096),
                "compressed",
                "log",
                "text_head_tail",
            )
            .unwrap();
        assert!(store.has_entries());
    }
    let later = serde_json::to_string(&enabled_tool_specs(&session, true)).unwrap();
    assert_eq!(first, later, "the tool surface changed mid-task");

    let declared: Value = serde_json::from_str(&first).unwrap();
    let names = declared
        .as_array()
        .unwrap()
        .iter()
        .map(|spec| spec["function"]["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(
        names.iter().any(|name| name == "retrieve_context"),
        "retrieve_context must be declared at task start, got {names:?}"
    );
    for spec in declared.as_array().unwrap() {
        // Exactly name, description, and parameters. Provider flags such as vLLM
        // strict mode are Veil's to add; emitting one here is what the shared
        // tool-contract fixture and the Veil consumer test guard against.
        let function = spec["function"].as_object().unwrap();
        assert_eq!(
            function.len(),
            3,
            "{} declares fields outside the internal contract: {:?}",
            spec["function"]["name"],
            function.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            spec["function"]["parameters"]["additionalProperties"],
            false
        );
    }
}

#[tokio::test]
async fn retrieve_context_answers_a_stable_result_when_nothing_is_stored() {
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "empty-store".into(),
            name: "retrieve_context".into(),
            arguments: json!({"hash": "0123456789abcdef"}),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.code.as_deref(), Some("context_not_available"));
    assert_eq!(result.details.as_ref().unwrap()["storeEmpty"], true);
}

#[tokio::test]
async fn tool_finished_events_carry_typed_details_and_continuation() {
    // Gate A: consumers read typed fields; deleting the prose must not remove
    // anything a consumer depends on.
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("README.md"),
        "alpha\nbravo\ncharlie\n",
    )
    .unwrap();
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        sink,
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "typed-read".into(),
            name: "read".into(),
            arguments: json!({"path": "README.md", "limit": 1}),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success");

    let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    let finished = observed
        .iter()
        .find(|event| event["type"] == "tool.finished")
        .expect("tool.finished");
    assert_eq!(finished["details"]["totalLines"], 3);
    assert_eq!(finished["details"]["shownEnd"], 1);
    assert_eq!(finished["continuation"]["nextOffset"], 2);
}

#[tokio::test]
async fn a_validation_failure_carries_the_field_that_was_wrong() {
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "typed-failure".into(),
            name: "read".into(),
            arguments: json!({"path": "README.md", "limit": 9_999}),
            index: 0,
        },
    )
    .await;
    let details = result.details.as_ref().expect("typed validation details");
    assert_eq!(details["tool"], "read");
    assert_eq!(details["field"], "limit");
    assert_eq!(details["code"], "invalid_arguments");
    assert!(
        details["allowedFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "offset"),
    );
}

#[tokio::test]
async fn the_generated_tool_contract_matches_the_shared_fixture() {
    // Veil validates the tool contract independently. Without a shared fixture,
    // the runner can emit a shape Veil rejects and every test on both sides
    // still passes — which is exactly how a stray field reached production.
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("runtime");
    std::fs::write(&executable, "fixture").unwrap();
    let mut session = crate::session::test_session(directory.path());
    Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config)
        .unwrap()
        .approved_executables
        .insert("runtime".into(), executable);

    let specs = enabled_tool_specs(&session, true);
    // The command description names the host shell, so the fixture is stored in
    // its POSIX form and both sides are normalized before comparison. Otherwise
    // the golden file only ever matches whichever platform last regenerated it.
    let canonical = |contract: &str| {
        contract
            .replace("\r\n", "\n")
            .replace("Windows PowerShell", "/bin/sh")
    };
    let encoded = canonical(&(serde_json::to_string_pretty(&specs).unwrap() + "\n"));
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/tests/fixtures/tool-contract.golden.json");
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&fixture, &encoded).unwrap();
    }
    let expected = canonical(&std::fs::read_to_string(&fixture).unwrap_or_default());
    assert_eq!(
        encoded, expected,
        "the generated tool contract changed; re-run with UPDATE_FIXTURES=1 and \
         confirm the Veil consumer test still accepts it",
    );
}

#[test]
fn artifact_is_absent_until_the_desktop_declares_the_service() {
    // The engines are the desktop's, not this host's. A runner that advertised
    // the tool on the strength of the capability alone would offer the model a
    // document builder with nothing behind it.
    let directory = tempfile::tempdir().unwrap();
    let mut session = crate::session::test_session(directory.path());
    Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config)
        .unwrap()
        .artifact_service = false;
    assert!(!tool_surface(&session).declares("artifact"));

    let declared = crate::session::test_session(directory.path());
    assert!(tool_surface(&declared).declares("artifact"));
}

#[tokio::test]
async fn an_artifact_action_missing_its_required_arguments_names_them() {
    let directory = tempfile::tempdir().unwrap();
    // The action matrix is not expressible in the schema, so it is the
    // executor's, and each action names the field it wanted rather than
    // reporting a generic shape error.
    for (arguments, expected) in [
        (json!({"action":"create","format":"pptx"}), "requires spec"),
        (json!({"action":"inspect"}), "requires path"),
        (json!({"action":"edit","path":"deck.pptx"}), "requires ops"),
    ] {
        let result = execute_tool(
            crate::session::test_session(directory.path()),
            crate::session::test_sink(directory.path()),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "matrix".into(),
                name: "artifact".into(),
                arguments,
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "validation_error");
        assert!(
            result.content.contains(expected),
            "expected {expected} in {}",
            result.content
        );
    }
}

#[tokio::test]
async fn an_oversize_artifact_spec_is_refused_before_any_job_is_emitted() {
    let directory = tempfile::tempdir().unwrap();
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();
    let filler = "x".repeat(2 * 1024 * 1024);
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        sink.clone(),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "oversize".into(),
            name: "artifact".into(),
            arguments: json!({"action":"create","format":"pptx","spec":{"note":filler}}),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "validation_error");
    assert_eq!(result.details.as_ref().unwrap()["field"], "spec");
    // Nothing but the tool's own lifecycle events: no job reached the desktop.
    let mut emitted = Vec::new();
    while let Ok(event) = events.try_recv() {
        emitted.push(event["type"].as_str().unwrap_or_default().to_owned());
    }
    assert!(!emitted.iter().any(|kind| kind == "artifact.requested"));
}

#[test]
fn unknown_fields_inside_an_artifact_spec_survive_the_contract() {
    // The wire-compat rule. The spec's interior belongs to the format schema
    // the worker owns; a runner that closed it would reject every field added
    // to an engine before this binary was rebuilt.
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let surface = tool_surface(&session);
    let arguments = json!({
        "action": "create",
        "format": "pptx",
        "spec": {"slides": [{"layout": "title", "someFutureField": {"nested": true}}]}
    });
    assert!(
        surface
            .validate("artifact", arguments.as_object().unwrap())
            .is_ok()
    );
    // The top level stays closed, which is what keeps a typo out of the tool.
    assert!(
        surface
            .validate(
                "artifact",
                json!({"action":"create","format":"pptx","spek":{}})
                    .as_object()
                    .unwrap()
            )
            .is_err()
    );
}

/// A file long enough that an unqualified read must bound itself, with every
/// line self-identifying so a window can be checked exactly.
fn numbered_workspace(lines: usize) -> (tempfile::TempDir, String) {
    let directory = tempfile::tempdir().unwrap();
    let body = (1..=lines)
        .map(|number| format!("line {number}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(directory.path().join("long.rs"), &body).unwrap();
    (directory, body)
}

#[tokio::test]
async fn a_centred_read_returns_the_window_around_one_line_and_reports_where_it_is() {
    let (directory, _) = numbered_workspace(1_000);
    let session = crate::session::test_session(directory.path());

    // The default radius, and the exact window the model asked for.
    let centred = read_tool(
        &session,
        json!({"path":"long.rs","line":120}).as_object().unwrap(),
    )
    .await
    .unwrap();
    let rows = centred.content.lines().collect::<Vec<_>>();
    assert_eq!(
        rows.first(),
        Some(&"line 100"),
        "window starts at line - radius"
    );
    assert_eq!(
        rows.last(),
        Some(&"line 140"),
        "window ends at line + radius"
    );
    assert_eq!(rows.len(), 41, "a radius of 20 covers 2 * 20 + 1 lines");
    // Raw text with no line-number prefixes; coordinates travel beside it, so
    // the content stays an exact slice that edit can copy from.
    assert!(centred.content.contains("line 120"));
    assert_eq!(
        centred.location.as_deref(),
        Some("long.rs lines 100-140 of 1000.")
    );
    assert!(
        centred
            .model_text("read")
            .contains("long.rs lines 100-140 of 1000.")
    );

    // A window clamped at the top of the file keeps its full reach below `line`,
    // so the caller still sees `radius` lines after the line it asked about.
    let clamped = read_tool(
        &session,
        json!({"path":"long.rs","line":5,"radius":20})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    let rows = clamped.content.lines().collect::<Vec<_>>();
    assert_eq!(rows.first(), Some(&"line 1"));
    assert_eq!(rows.last(), Some(&"line 25"));

    // A window past the end of the file is empty rather than an error, and says so.
    let beyond = read_tool(
        &session,
        json!({"path":"long.rs","line":5_000,"radius":2})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(beyond.content.is_empty());
    assert_eq!(
        beyond.location.as_deref(),
        Some("long.rs: no lines in range; the file has 1000 lines.")
    );
}

#[tokio::test]
async fn an_unqualified_read_is_bounded_and_the_rest_stays_reachable() {
    // The whole point of the change: the cheapest call to type no longer costs
    // the whole file, but nothing becomes unreachable.
    let (directory, body) = numbered_workspace(1_000);
    let session = crate::session::test_session(directory.path());

    let bare = read_tool(&session, json!({"path":"long.rs"}).as_object().unwrap())
        .await
        .unwrap();
    let rows = bare.content.lines().collect::<Vec<_>>();
    assert_eq!(rows.len(), catalog::DEFAULT_READ_LINES as usize);
    assert_eq!(rows.first(), Some(&"line 1"));
    assert_eq!(
        bare.location.as_deref(),
        Some("long.rs lines 1-400 of 1000.")
    );
    let next = bare
        .continuation
        .as_ref()
        .and_then(|value| value.get("nextOffset"))
        .and_then(Value::as_u64)
        .expect("a bounded read reports where to continue");
    assert_eq!(next, 401);

    // An explicit limit still reaches the whole file, so the bound is a default
    // and not a ceiling.
    let whole = read_tool(
        &session,
        json!({"path":"long.rs","limit":catalog::MAX_READ_LINES})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(whole.content.lines().count(), 1_000);
    assert!(whole.continuation.is_none());
    assert!(body.contains(&whole.content));

    // A file inside the default budget is unchanged: no truncation, no continuation.
    let (small, small_body) = numbered_workspace(40);
    let small_session = crate::session::test_session(small.path());
    let short = read_tool(
        &small_session,
        json!({"path":"long.rs"}).as_object().unwrap(),
    )
    .await
    .unwrap();
    assert!(small_body.contains(&short.content));
    assert!(short.continuation.is_none());
}

#[tokio::test]
async fn a_window_read_still_feeds_a_byte_exact_edit() {
    // Gate A again, but for the windowed form: coordinates live beside the
    // content, so what the model copies is still an exact slice of the file.
    let directory = tempfile::tempdir().unwrap();
    let original = "alpha\r\nbravo\r\ncharlie\r\ndelta\r\n";
    std::fs::write(directory.path().join("crlf.txt"), original).unwrap();
    let session = crate::session::test_session(directory.path());

    let read = read_tool(
        &session,
        json!({"path":"crlf.txt","line":2,"radius":1})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        original.contains(&read.content),
        "windowed read {:?} is not an exact slice",
        read.content
    );
    let result = execute_tool(
        session,
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "window-edit".into(),
            name: "edit".into(),
            arguments: json!({
                "path": "crlf.txt",
                "edits": [{"oldText": read.content, "newText": read.content.replace("bravo", "BRAVO")}],
            }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert_eq!(
        std::fs::read_to_string(directory.path().join("crlf.txt")).unwrap(),
        original.replace("bravo", "BRAVO")
    );
}

#[tokio::test]
async fn a_read_cannot_mix_a_centred_window_with_paging() {
    // Individually valid fields that mean two different things together are
    // rejected with the field named, rather than resolved by silent precedence.
    let (directory, _) = numbered_workspace(100);
    let session = crate::session::test_session(directory.path());
    let surface = tool_surface(&session);
    for invalid in [
        json!({"path":"long.rs","line":10,"offset":5}),
        json!({"path":"long.rs","line":10,"limit":5}),
        // radius is meaningless on its own: it centres nothing.
        json!({"path":"long.rs","radius":5}),
        json!({"path":"long.rs","radius":5,"offset":2}),
    ] {
        let violation = surface
            .validate("read", invalid.as_object().unwrap())
            .expect_err(&format!("read accepted {invalid}"));
        assert_eq!(violation.code, "invalid_arguments");
        assert!(
            matches!(violation.field.as_deref(), Some("line" | "radius")),
            "{invalid} blamed {:?}",
            violation.field
        );
    }
    for valid in [
        json!({"path":"long.rs","line":10}),
        json!({"path":"long.rs","line":10,"radius":0}),
        json!({"path":"long.rs","offset":5,"limit":5}),
        json!({"path":"long.rs"}),
    ] {
        assert!(
            surface.validate("read", valid.as_object().unwrap()).is_ok(),
            "read rejected {valid}"
        );
    }
}
