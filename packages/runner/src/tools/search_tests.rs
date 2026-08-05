//! Tests for the warm workspace `search` tool: ranking, smart case, policy
//! inheritance, bounded content scanning, and index freshness.

use std::sync::Arc;

use super::*;

// --- search: warm workspace locator -----------------------------------------

/// Builds a workspace whose visible files exercise ordering, scoping, and the
/// blocked/generated policy that `search` must inherit from `find`/`grep`.
fn search_workspace() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for relative in ["src/renderer", "src/main", "node_modules/pkg", "docs"] {
        std::fs::create_dir_all(root.join(relative)).unwrap();
    }
    std::fs::write(
        root.join("src/renderer/main.tsx"),
        "export const Main = 1;\n",
    )
    .unwrap();
    std::fs::write(
        root.join("src/main/runnerAdapter.ts"),
        "const harnessRoute = 'engineering';\nexport { harnessRoute };\n",
    )
    .unwrap();
    std::fs::write(root.join("src/main/Main.ts"), "// Uppercase Main marker\n").unwrap();
    std::fs::write(root.join("docs/plan.md"), "# harnessRoute notes\n").unwrap();
    // Must never be indexed: generated tree, secret name, dotenv.
    std::fs::write(root.join("node_modules/pkg/main.tsx"), "generated\n").unwrap();
    std::fs::write(root.join("secret-notes.txt"), "harnessRoute\n").unwrap();
    std::fs::write(root.join(".env"), "TOKEN=1\n").unwrap();
    directory
}

async fn run_search(session: &Arc<Session>, arguments: Value) -> ToolResult {
    execute_tool(
        session.clone(),
        crate::session::test_sink(&session.config.cwd),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "search".into(),
            name: "search".into(),
            arguments,
            index: 0,
        },
    )
    .await
}

#[tokio::test]
async fn search_path_mode_ranks_basenames_before_path_substrings() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());
    let result = run_search(&session, json!({"query":"main","mode":"path","path":"."})).await;
    assert_eq!(result.status, "success", "{:?}", result.error_message);
    let rows = result.content.lines().collect::<Vec<_>>();
    // Exact basename, then prefix, then the directory whose own name matches,
    // then paths that merely contain the query. Ties are lexical.
    let position = |needle: &str| {
        rows.iter()
            .position(|row| *row == needle)
            .unwrap_or_else(|| panic!("{needle} missing from {rows:?}"))
    };
    assert!(position("src/main/Main.ts") < position("src/renderer/main.tsx"));
    assert!(position("src/main") < position("src/main/runnerAdapter.ts"));
    assert!(!result.content.contains("node_modules"));
}

#[tokio::test]
async fn search_is_smart_case_and_falls_back_to_all_query_tokens() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());

    let insensitive = run_search(&session, json!({"query":"main","mode":"path","path":"."})).await;
    assert!(insensitive.content.contains("src/main/Main.ts"));
    assert!(insensitive.content.contains("src/renderer/main.tsx"));

    // An uppercase character anywhere makes the query case-sensitive.
    let sensitive = run_search(&session, json!({"query":"Main","mode":"path","path":"."})).await;
    assert!(sensitive.content.contains("src/main/Main.ts"));
    assert!(
        !sensitive.content.contains("src/renderer/main.tsx"),
        "lowercase basename must not match an uppercase query: {}",
        sensitive.content
    );

    // Multi-token queries match when every token appears in the relative path.
    let tokens = run_search(
        &session,
        json!({"query":"renderer tsx","mode":"path","path":"."}),
    )
    .await;
    assert!(tokens.content.contains("src/renderer/main.tsx"));

    // A path matching no rule is omitted; v1 has no edit-distance matcher.
    let miss = run_search(
        &session,
        json!({"query":"zzzznomatch","mode":"path","path":"."}),
    )
    .await;
    assert_eq!(miss.content, "No matching paths.");
    assert_eq!(
        miss.details
            .as_ref()
            .and_then(|value| value.get("resultCount")),
        Some(&json!(0))
    );
}

#[tokio::test]
async fn search_inherits_scope_glob_and_blocked_path_policy() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());

    let scoped = run_search(
        &session,
        json!({"query":"main","mode":"path","path":"src/renderer"}),
    )
    .await;
    assert!(scoped.content.contains("src/renderer/main.tsx"));
    assert!(!scoped.content.contains("src/main/"));

    let globbed = run_search(
        &session,
        json!({"query":"main","mode":"path","path":".","glob":"*.ts"}),
    )
    .await;
    assert!(globbed.content.contains("src/main/Main.ts"));
    assert!(!globbed.content.contains("main.tsx"));

    // Generated trees, secret-named files, and dotenv never reach the model,
    // in either mode.
    for mode in ["path", "content"] {
        let result = run_search(
            &session,
            json!({"query":"harnessRoute","mode":mode,"path":"."}),
        )
        .await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert!(!result.content.contains("node_modules"), "{mode}");
        assert!(!result.content.contains("secret-notes"), "{mode}");
        assert!(!result.content.contains(".env"), "{mode}");
    }

    let escape = run_search(&session, json!({"query":"main","mode":"path","path":"../"})).await;
    assert_eq!(escape.status, "policy_blocked");
}

#[tokio::test]
async fn search_content_mode_returns_path_line_text_and_is_bounded() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());
    let result = run_search(
        &session,
        json!({"query":"harnessRoute","mode":"content","path":"."}),
    )
    .await;
    assert_eq!(result.status, "success", "{:?}", result.error_message);
    assert!(
        result
            .content
            .contains("src/main/runnerAdapter.ts:1: const harnessRoute = 'engineering';")
    );
    assert!(
        result
            .content
            .contains("docs/plan.md:1: # harnessRoute notes")
    );
    let details = result.details.as_ref().unwrap();
    assert_eq!(details["mode"], json!("content"));
    assert!(details.get("filesScanned").is_some());
    assert!(details.get("filesSkipped").is_some());

    let capped = run_search(
        &session,
        json!({"query":"harnessRoute","mode":"content","path":".","limit":1}),
    )
    .await;
    assert_eq!(capped.content.lines().count(), 1);
    assert_eq!(capped.details.as_ref().unwrap()["truncated"], json!(true));
    // Path mode reports no scan counters; they do not apply.
    let paths = run_search(&session, json!({"query":"plan","mode":"path","path":"."})).await;
    assert!(
        paths
            .details
            .as_ref()
            .unwrap()
            .get("filesScanned")
            .is_none()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn search_never_follows_symlinks_out_of_the_workspace() {
    let directory = search_workspace();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("leaked.txt"), "harnessRoute leaked\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("linked")).unwrap();
    let session = crate::session::test_session(directory.path());
    for mode in ["path", "content"] {
        let result = run_search(&session, json!({"query":"leaked","mode":mode,"path":"."})).await;
        assert!(
            !result.content.contains("leaked"),
            "{mode}: {}",
            result.content
        );
    }
}

#[tokio::test]
async fn search_observes_creates_deletes_and_command_staleness() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());

    let before = run_search(&session, json!({"query":"fresh","mode":"path","path":"."})).await;
    assert_eq!(before.content, "No matching paths.");

    // A typed write patches the index in place, including new parent dirs.
    let permissions = Arc::new(crate::permission::PermissionBroker::default());
    let write = execute_tool(
        session.clone(),
        crate::session::test_sink(directory.path()),
        permissions.clone(),
        ToolCall {
            id: "write".into(),
            name: "write".into(),
            arguments: json!({"path":"src/added/fresh.ts","content":"const fresh = 1;\n"}),
            index: 0,
        },
    )
    .await;
    assert_eq!(write.status, "success", "{:?}", write.error_message);
    let after = run_search(&session, json!({"query":"fresh","mode":"path","path":"."})).await;
    assert!(
        after.content.contains("src/added/fresh.ts"),
        "{}",
        after.content
    );
    assert!(after.content.contains("src/added"), "parent dir indexed");

    // A file created out of band is only observed after the index goes stale.
    std::fs::write(directory.path().join("docs/outofband.md"), "x\n").unwrap();
    let unseen = run_search(
        &session,
        json!({"query":"outofband","mode":"path","path":"."}),
    )
    .await;
    assert_eq!(unseen.content, "No matching paths.");
    session.search_index.mark_stale();
    let seen = run_search(
        &session,
        json!({"query":"outofband","mode":"path","path":"."}),
    )
    .await;
    assert!(seen.content.contains("docs/outofband.md"));

    // A command invalidates coarsely regardless of exit status: it can mutate the
    // tree before it fails, times out, or is aborted. `git status` is the audited
    // read-only class, and in a bare temp directory it exits non-zero.
    std::fs::write(directory.path().join("docs/afterfail.md"), "x\n").unwrap();
    let failed = execute_tool(
        session.clone(),
        crate::session::test_sink(directory.path()),
        permissions,
        ToolCall {
            id: "cmd".into(),
            name: "command".into(),
            arguments: json!({"command":"git status --short"}),
            index: 0,
        },
    )
    .await;
    assert_ne!(
        failed.exit_code,
        Some(0),
        "expected a failing command: {failed:?}"
    );
    let refreshed = run_search(
        &session,
        json!({"query":"afterfail","mode":"path","path":"."}),
    )
    .await;
    assert!(
        refreshed.content.contains("docs/afterfail.md"),
        "{}",
        refreshed.content
    );
}

#[tokio::test]
async fn search_settles_without_results_when_the_run_is_aborted() {
    let directory = search_workspace();
    let session = crate::session::test_session(directory.path());
    let _run = session.try_begin_run().unwrap();
    session.abort();
    let result = run_search(&session, json!({"query":"main","mode":"path","path":"."})).await;
    // Dispatch rejects a call on an aborted run before the walk starts; either
    // way the run settles with no leaked task and no partial index published.
    assert_eq!(result.status, "aborted");
    // The index is still usable once a fresh run begins.
    drop(_run);
    let next = run_search(&session, json!({"query":"main","mode":"path","path":"."})).await;
    assert_eq!(next.status, "success", "{:?}", next.error_message);
}
