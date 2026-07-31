use super::*;

async fn execute_command_for_test(command: &str, timeout_ms: u64) -> ToolResult {
    let directory = tempfile::tempdir().unwrap();
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
    task.await.unwrap()
}

#[tokio::test]
async fn commands_report_success_nonzero_exit_and_timeout_distinctly() {
    let success = execute_command_for_test("echo runner-command-ok", 5_000).await;
    assert_eq!(success.status, "success");
    assert!(success.output.contains("runner-command-ok"));

    let failure = execute_command_for_test("exit 7", 5_000).await;
    assert_eq!(failure.status, "runtime_error");
    assert_eq!(failure.error_code.as_deref(), Some("command_exit_nonzero"));
    assert_eq!(failure.exit_code, Some(7));

    let command = if cfg!(windows) {
        "Start-Sleep -Milliseconds 1000"
    } else {
        "sleep 1"
    };
    let timeout = execute_command_for_test(command, 100).await;
    assert_eq!(timeout.status, "timeout");
    assert_eq!(timeout.error_code.as_deref(), Some("process_timeout"));

    let silent_timeout = execute_command_for_test(command, 5_000).await;
    assert_eq!(silent_timeout.status, "timeout");
    assert_eq!(
        silent_timeout.error_code.as_deref(),
        Some("process_silent_timeout")
    );
    assert_eq!(
        silent_timeout.error_message.as_deref(),
        Some("Command stopped after 30 seconds without stdout or stderr output.")
    );
}
