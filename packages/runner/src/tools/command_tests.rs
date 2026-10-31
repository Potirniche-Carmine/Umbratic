use super::*;
#[cfg(unix)]
use std::fs;

async fn execute_command_for_test(command: &str, timeout_ms: u64) -> ToolResult {
    execute_command_in(tempfile::tempdir().unwrap(), command, timeout_ms)
        .await
        .0
}

async fn execute_command_in(
    directory: tempfile::TempDir,
    command: &str,
    timeout_ms: u64,
) -> (ToolResult, tempfile::TempDir) {
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();
    let permissions = Arc::new(crate::permission::PermissionBroker::default());
    let task = tokio::spawn(execute_tool(
        crate::session::test_session(directory.path()),
        sink.clone(),
        permissions.clone(),
        ToolCall {
            id: "command".into(),
            name: "command".into(),
            arguments: json!({"command":command,"timeoutMs":timeout_ms}),
            index: 0,
        },
    ));
    loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "permission.requested" {
            permissions.reply(&sink, event["permissionId"].as_str().unwrap(), "allow");
            break;
        }
    }
    (task.await.unwrap(), directory)
}

#[tokio::test]
async fn commands_report_success_nonzero_exit_and_timeout_distinctly() {
    let success = execute_command_for_test("echo runner-command-ok", 5_000).await;
    assert_eq!(success.status, "success");
    assert!(success.content.contains("runner-command-ok"));
    assert!(success.content.contains("capturedBytes="));
    assert!(success.content.contains("originalBytes="));
    assert!(success.content.contains("captureTruncated="));
    assert_eq!(
        success
            .details
            .as_ref()
            .and_then(|value| value.get("captureTruncated"))
            .and_then(Value::as_bool),
        Some(false)
    );

    let failure = execute_command_for_test("exit 7", 5_000).await;
    assert_eq!(failure.status, "runtime_error");
    assert_eq!(failure.code.as_deref(), Some("command_exit_nonzero"));
    assert_eq!(failure.exit_code, Some(7));

    let command = if cfg!(windows) {
        "Start-Sleep -Milliseconds 3000"
    } else {
        "sleep 3"
    };
    let timeout = execute_command_for_test(command, 100).await;
    assert_eq!(timeout.status, "timeout");
    assert_eq!(timeout.code.as_deref(), Some("process_timeout"));

    // Silent commands must not be killed merely for lack of output.
    let silent = execute_command_for_test(command, 10_000).await;
    assert_eq!(silent.status, "success");
    assert_ne!(silent.code.as_deref(), Some("process_silent_timeout"));
}

#[tokio::test]
async fn command_output_retains_the_useful_tail() {
    let command = if cfg!(windows) {
        "$i=1; while ($i -le 400) { Write-Output (\"marker-$i-\" + (\"x\" * 200)); $i++ }"
    } else {
        "i=1; while [ \"$i\" -le 400 ]; do printf 'marker-%s-%s\\n' \"$i\" \"$(printf 'x%.0s' {1..200})\"; i=$((i+1)); done"
    };
    let result = execute_command_for_test(command, 30_000).await;
    assert_eq!(result.status, "success", "{:?}", result.error_message);
    assert!(
        result.content.contains("marker-400-"),
        "tail should retain the newest lines; content tail={}",
        result
            .content
            .chars()
            .rev()
            .take(240)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    );
    assert!(
        result
            .details
            .as_ref()
            .and_then(|value| value.get("contextHash"))
            .and_then(Value::as_str)
            .is_some()
    );
    assert!(
        result
            .details
            .as_ref()
            .and_then(|value| value.get("capturedBytes"))
            .and_then(Value::as_u64)
            .is_some_and(|bytes| bytes > 0)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_reaps_the_spawned_process_tree() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("worker.pid");
    let command = format!("sleep 30 & echo $! > '{}'; wait", marker.display());
    let (timeout, workspace) = execute_command_in(directory, &command, 500).await;
    assert_eq!(timeout.status, "timeout");
    assert_eq!(timeout.code.as_deref(), Some("process_timeout"));

    let pid: u32 = fs::read_to_string(workspace.path().join("worker.pid"))
        .unwrap_or_default()
        .trim()
        .parse()
        .unwrap_or(0);
    assert_ne!(pid, 0, "the command never recorded a child pid");
    for _ in 0..40 {
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("child {pid} outlived the timed-out command");
}

#[tokio::test]
async fn commands_do_not_inherit_runner_stdin() {
    const CHILD: &str = "UMBRATIC_TEST_COMMAND_STDIN";
    if std::env::var_os(CHILD).is_some() {
        let command = if cfg!(windows) {
            "$line = [Console]::In.ReadLine(); if ($null -ne $line) { exit 19 }; Write-Output stdin-closed"
        } else {
            "if read -r line; then exit 19; fi; printf stdin-closed"
        };
        let result = execute_command_for_test(command, 5_000).await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert!(result.content.contains("stdin-closed"));
        return;
    }

    // Keep the runner's input pipe open and empty. An inheriting tool would
    // block on its read until the unchanged command deadline expires.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tools::command_tests::commands_do_not_inherit_runner_stdin",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _open_input = child.stdin.take().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .expect("command test process exceeded its own command deadline")
        .unwrap();
    assert!(
        output.status.success(),
        "child test failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
