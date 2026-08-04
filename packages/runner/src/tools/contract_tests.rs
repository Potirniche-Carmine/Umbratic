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
    let encoded = serde_json::to_string_pretty(&specs).unwrap() + "\n";
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/tests/fixtures/tool-contract.golden.json");
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&fixture, &encoded).unwrap();
    }
    let expected = std::fs::read_to_string(&fixture)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert_eq!(
        encoded.replace("\r\n", "\n"),
        expected,
        "the generated tool contract changed; re-run with UPDATE_FIXTURES=1 and \
         confirm the Veil consumer test still accepts it",
    );
}
