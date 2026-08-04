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
