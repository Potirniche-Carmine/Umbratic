//! Tests for the warm workspace `search` tool: ranking, smart case, policy
//! inheritance, bounded content scanning, and index freshness.

use std::sync::Arc;

use super::*;

// --- search: warm workspace locator -----------------------------------------

/// Builds a workspace whose visible files exercise ordering, scoping, and the
/// blocked/generated policy that `search` must inherit from `find`.
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

#[tokio::test]
async fn content_search_shows_the_lines_around_a_match_without_opening_the_file() {
    // The point of context here: a search that already shows the surrounding
    // code removes the read that would otherwise pull in the whole file.
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("app.rs"),
        "alpha\nbravo\ncharlie\nNEEDLE\ndelta\necho\nfoxtrot\n",
    )
    .unwrap();
    let session = crate::session::test_session(directory.path());

    let bare = run_search(
        &session,
        json!({"query":"NEEDLE","mode":"content","path":"."}),
    )
    .await;
    assert_eq!(bare.status, "success", "{:?}", bare.error_message);
    assert_eq!(bare.content, "app.rs:4: NEEDLE", "context defaults to none");

    let with_context = run_search(
        &session,
        json!({"query":"NEEDLE","mode":"content","path":".","context":2}),
    )
    .await;
    assert_eq!(
        with_context.content,
        // ':' marks the match and '-' the context.
        "app.rs:2- bravo\napp.rs:3- charlie\napp.rs:4: NEEDLE\napp.rs:5- delta\napp.rs:6- echo"
    );
    // limit bounds matches; the context lines ride along without inflating the
    // count the model reasons about.
    assert_eq!(
        with_context
            .details
            .as_ref()
            .and_then(|value| value.get("resultCount"))
            .and_then(Value::as_u64),
        Some(1)
    );
}

#[tokio::test]
async fn overlapping_context_windows_never_repeat_a_line() {
    let directory = tempfile::tempdir().unwrap();
    // Matches two lines apart, so their context windows overlap in both
    // directions and the shared line must appear exactly once.
    std::fs::write(
        directory.path().join("app.rs"),
        "one\nHIT\nthree\nHIT\nfive\n",
    )
    .unwrap();
    let session = crate::session::test_session(directory.path());
    let result = run_search(
        &session,
        json!({"query":"HIT","mode":"content","path":".","context":2}),
    )
    .await;
    assert_eq!(
        result.content,
        "app.rs:1- one\napp.rs:2: HIT\napp.rs:3- three\napp.rs:4: HIT\napp.rs:5- five"
    );
    let numbers = result
        .content
        .lines()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(numbers.len(), result.content.lines().count());
}

#[tokio::test]
async fn a_content_limit_bounds_matches_and_reports_truncation() {
    let directory = tempfile::tempdir().unwrap();
    let body = (1..=10)
        .map(|number| format!("pad {number}\nHIT {number}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(directory.path().join("app.rs"), body + "\n").unwrap();
    let session = crate::session::test_session(directory.path());
    let result = run_search(
        &session,
        json!({"query":"HIT","mode":"content","path":".","context":1,"limit":3}),
    )
    .await;
    assert_eq!(result.status, "success", "{:?}", result.error_message);
    let matches = result
        .content
        .lines()
        .filter(|line| line.contains(": HIT"))
        .count();
    assert_eq!(matches, 3, "limit bounds matching lines, not rows");
    assert!(
        result.content.lines().count() > matches,
        "context accompanied them"
    );
    let details = result.details.as_ref().unwrap();
    assert_eq!(details.get("resultCount").and_then(Value::as_u64), Some(3));
    assert_eq!(
        details.get("truncated").and_then(Value::as_bool),
        Some(true)
    );
}

#[tokio::test]
async fn a_file_revealed_as_binary_contributes_no_context_rows() {
    // Context rows are held per file, so a file that turns out to be binary
    // after a match still contributes nothing at all.
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("clean.txt"), "pre\nMARK\npost\n").unwrap();
    std::fs::write(
        directory.path().join("mixed.bin"),
        b"pre\nMARK\npost\n\0binary\n".as_slice(),
    )
    .unwrap();
    let session = crate::session::test_session(directory.path());
    let result = run_search(
        &session,
        json!({"query":"MARK","mode":"content","path":".","context":1}),
    )
    .await;
    assert!(!result.content.contains("mixed.bin"), "{}", result.content);
    assert_eq!(
        result.content,
        "clean.txt:1- pre\nclean.txt:2: MARK\nclean.txt:3- post"
    );
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|value| value.get("filesSkipped"))
            .and_then(Value::as_u64),
        Some(1)
    );
}

#[tokio::test]
async fn regex_mode_matches_patterns_and_shares_the_smart_case_rule() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("app.rs"),
        "fn loginHandler() {}\nfn logoutHandler() {}\nfn helper() {}\nLOGIN\n",
    )
    .unwrap();
    let session = crate::session::test_session(directory.path());

    let matched = run_search(
        &session,
        json!({"query":r"fn log\w+Handler","mode":"regex","path":"."}),
    )
    .await;
    assert_eq!(matched.status, "success", "{:?}", matched.error_message);
    assert_eq!(
        matched.content,
        "app.rs:1: fn loginHandler() {}\napp.rs:2: fn logoutHandler() {}"
    );

    // Smart case is one rule across every mode: an all-lowercase pattern is
    // insensitive, so it also reaches the uppercase line.
    let insensitive =
        run_search(&session, json!({"query":"login","mode":"regex","path":"."})).await;
    assert!(insensitive.content.contains("app.rs:1:"));
    assert!(insensitive.content.contains("app.rs:4: LOGIN"));

    // An uppercase character in the pattern means the caller meant it.
    let sensitive = run_search(&session, json!({"query":"LOGIN","mode":"regex","path":"."})).await;
    assert_eq!(sensitive.content, "app.rs:4: LOGIN");

    // The regex crate's inline flag is the documented override.
    let forced = run_search(
        &session,
        json!({"query":"(?i)LOGIN","mode":"regex","path":"."}),
    )
    .await;
    assert!(forced.content.contains("app.rs:1:"));

    // Context and limit behave identically to content mode.
    let with_context = run_search(
        &session,
        json!({"query":r"^fn helper","mode":"regex","path":".","context":1}),
    )
    .await;
    assert_eq!(
        with_context.content,
        "app.rs:2- fn logoutHandler() {}\napp.rs:3: fn helper() {}\napp.rs:4- LOGIN"
    );
}

#[tokio::test]
async fn an_unusable_regex_fails_before_any_scanning() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("app.rs"), "anything\n").unwrap();
    let session = crate::session::test_session(directory.path());
    let result = run_search(
        &session,
        json!({"query":"fn (unclosed","mode":"regex","path":"."}),
    )
    .await;
    assert_eq!(result.status, "validation_error");
    assert_eq!(result.code.as_deref(), Some("invalid_regex"));
    // The same string is a perfectly good literal, and the error says so.
    assert!(
        result.content.contains("mode content"),
        "{}",
        result.content
    );
    let literal = run_search(
        &session,
        json!({"query":"fn (unclosed","mode":"content","path":"."}),
    )
    .await;
    assert_eq!(literal.status, "success");
}

// Locator contract tests. These moved here when grep was merged into search:
// search is now the only tool that answers them.
#[tokio::test]
async fn exact_search_contract_scopes_results_and_returns_path_line_text() {
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
                "mode":"content",
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
            .content
            .contains("src/renderer/main.tsx:1: <span>Auto-run low risk</span>")
    );
    assert!(!result.content.contains("other/main.tsx"));
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

// On Windows a glob in a path argument used to fail deep in the filesystem with
// "The filename, directory name, or volume label syntax is incorrect", a raw OS
// error that names no correction — observed sending a live run into a minute of
// search retries. The shell form means the same thing as the two-argument form
// on every tool that has a glob field, so it executes instead of failing.
#[tokio::test]
async fn glob_patterns_in_path_relocate_to_the_glob_argument() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(directory.path().join("src")).unwrap();
    std::fs::write(directory.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(directory.path().join("src/notes.txt"), "fn main\n").unwrap();
    let session = crate::session::test_session(directory.path());

    let matched = search_tool(
        crate::session::test_session(directory.path()),
        json!({"query":"main","mode":"content","path":"src/*.rs"})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        matched.content.contains("src/main.rs:1:"),
        "{}",
        matched.content
    );
    // The relocated pattern still filters: the .txt sibling also matches the
    // text, so seeing it would mean the glob was dropped rather than moved.
    assert!(
        !matched.content.contains("notes.txt"),
        "{}",
        matched.content
    );

    let found = find_tool(&session, json!({"path":"src/*.rs"}).as_object().unwrap())
        .await
        .unwrap();
    assert_eq!(found.content, "src/main.rs");

    let searched = search_tool(
        crate::session::test_session(directory.path()),
        json!({"query":"main","mode":"path","path":"src/*.rs"})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        searched.content.contains("src/main.rs"),
        "{}",
        searched.content
    );

    // Two different patterns is a genuine ambiguity, not a repair.
    let conflict = search_tool(
        crate::session::test_session(directory.path()),
        json!({"query":"main","mode":"content","path":"src/*.rs","glob":"*.txt"})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap_err();
    assert!(
        conflict.message.contains("exactly one pattern in glob"),
        "{}",
        conflict.message
    );

    // ls and read have nowhere to put a pattern, so they still refuse — and the
    // refusal names the tool that does accept one.
    let ls = ls_tool(&session, json!({"path":"src/*.rs"}).as_object().unwrap())
        .await
        .unwrap_err();
    assert!(ls.message.contains("not a pattern"), "{}", ls.message);
    assert!(ls.message.contains("find"), "{}", ls.message);
    assert!(!ls.message.contains("os error"), "{}", ls.message);

    // `[` stays legal: real projects use bracketed route directories.
    std::fs::create_dir_all(directory.path().join("src/[id]")).unwrap();
    std::fs::write(directory.path().join("src/[id]/page.tsx"), "export {}\n").unwrap();
    read_tool(
        &session,
        json!({"path":"src/[id]/page.tsx"}).as_object().unwrap(),
    )
    .await
    .unwrap();
}
