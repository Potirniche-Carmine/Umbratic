use super::*;

const DEFAULT_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const PROGRESS_COALESCE_MS: u64 = 100;
const MAX_UI_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES: usize = 512 * 1024;

pub(super) async fn command_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
    call_id: &str,
    safety: &SafetyDecision,
) -> ToolExecutionResult {
    let command = command_display(input).trim().to_owned();
    if command.is_empty() {
        return Err("command requires command or programId".into());
    }
    let program_id = string_arg(input, &["programId"]);
    let program_args = string_list_arg(input, &["args"]);
    sink.emit(json!({
        "type": "command.safety.decision",
        "taskId": session.task_id,
        "toolCallId": call_id,
        "policyVersion": safety.policy_version,
        "action": safety.action,
        "severity": safety.severity,
        "certainty": safety.certainty,
        "commandClass": safety.command_class,
        "ruleId": safety.rule_id,
        "explanation": safety.explanation,
        "matchedSpan": safety.matched_span,
        "suggestion": safety.suggestion,
        "commandFingerprint": safety.command_fingerprint,
        "cwdFingerprint": safety.cwd_fingerprint,
        "at": now_iso(),
    }));
    if safety.action == SafetyAction::Deny {
        return Err(ToolError::policy(format!(
            "Command blocked by policy: {}",
            safety.explanation
        )));
    }
    let executable = if program_id.is_empty() {
        None
    } else {
        let configured = session
            .config
            .approved_executables
            .get(&program_id)
            .ok_or_else(|| {
                ToolError::policy(format!(
                    "Executable {program_id} is not available. Use only a programId declared by run_program."
                ))
            })?;
        let executable = configured.canonicalize().map_err(|_| {
            ToolError::policy(format!("Executable {program_id} is no longer available."))
        })?;
        if &executable != configured || !executable.is_file() {
            return Err(ToolError::policy(format!(
                "Executable {program_id} changed after startup."
            )));
        }
        Some(executable)
    };
    let auto_allow = session.config.permission_mode == PermissionMode::AutoSafe
        && safety.action == SafetyAction::Allow;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "bash",
            &redact_text(&command, 320),
            auto_allow,
        )
        .await;
    if decision == "abort" {
        return Err(ToolError::aborted(
            "The tool call was aborted before the command ran.",
        ));
    }
    if decision != "allow" {
        return Err(ToolError::permission(
            "The user rejected this command. It was not run. Do not repeat it unless the user makes a new request that authorizes it.",
        ));
    }
    // The catalog declares timeoutMs as an integer in [MIN_TIMEOUT_MS,
    // MAX_TIMEOUT_MS] and rejects anything outside that before dispatch, so a
    // value that arrives here is already in range. Re-clamping only hid the day
    // the two bounds disagreed.
    let requested = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let mut process = if let Some(executable) = executable {
        let mut value = Command::new(executable);
        value.args(&program_args);
        value
    } else if cfg!(windows) {
        let shell = resolve_trusted_shell()?;
        let mut value = Command::new(&shell);
        value.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &command,
        ]);
        value
    } else {
        let shell = resolve_trusted_shell()?;
        let mut value = Command::new(&shell);
        value.args(["-c", &command]);
        value
    };
    process
        .current_dir(&session.config.cwd)
        .env_clear()
        .envs(safe_command_environment())
        // Tools have no stdin contract. Never expose the runner control stream
        // or let a noninteractive child wait for that stream to close.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture command stdout".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to capture command stderr".to_owned())?;

    let stdout_capture = Arc::new(Mutex::new(StreamCapture::default()));
    let stderr_capture = Arc::new(Mutex::new(StreamCapture::default()));
    let stdout_task = tokio::spawn(collect_stream(
        stdout,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stdout",
        stdout_capture.clone(),
    ));
    let stderr_task = tokio::spawn(collect_stream(
        stderr,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stderr",
        stderr_capture.clone(),
    ));
    let deadline = TokioInstant::now() + Duration::from_millis(requested);
    let mut abort_poll = interval(Duration::from_millis(25));
    let mut timed_out = false;
    let mut aborted = false;
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.map_err(|error| error.to_string())?,
            _ = sleep_until(deadline) => {
                timed_out = true;
                terminate_command_tree(&mut child, pid).await;
                break child.wait().await.map_err(|error| error.to_string())?;
            }
            _ = abort_poll.tick() => {
                if session.is_aborted() {
                    aborted = true;
                    terminate_command_tree(&mut child, pid).await;
                    break child.wait().await.map_err(|error| error.to_string())?;
                }
            }
        }
    };
    // Wait for stream collectors so the process tree has settled before releasing the barrier.
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let stdout_stats = stdout_capture
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let stderr_stats = stderr_capture
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let exit = status.code();
    let success = status.success() && !timed_out && !aborted;
    let original_bytes = stdout_stats
        .original_bytes
        .saturating_add(stderr_stats.original_bytes);
    let captured_bytes = stdout_stats
        .captured
        .len()
        .saturating_add(stderr_stats.captured.len());
    let capture_truncated = stdout_stats.capture_truncated || stderr_stats.capture_truncated;
    let mut spool = String::new();
    if !stdout_stats.captured.is_empty() {
        spool.push_str(&stdout_stats.captured);
    }
    if !stderr_stats.captured.is_empty() {
        if !spool.is_empty() {
            spool.push('\n');
        }
        spool.push_str(&stderr_stats.captured);
    }
    let context_hash = {
        let mut store = session.context_store.lock().await;
        store
            .store(
                call_id,
                if program_id.is_empty() {
                    "command"
                } else {
                    "run_program"
                },
                &redact_text(&command, 320),
                &spool,
                &spool,
                "log",
                "command_tail",
            )
            .ok()
            .map(|entry| entry.hash)
    };
    let mut body_parts = vec![format!(
        "exitCode={}",
        exit.map_or_else(|| "unknown".into(), |value| value.to_string())
    )];
    body_parts.push(format!(
        "capturedBytes={captured_bytes} originalBytes={original_bytes} captureTruncated={capture_truncated}"
    ));
    if let Some(hash) = &context_hash {
        body_parts.push(format!("contextHash={hash}"));
    }
    if !stdout_stats.captured.trim().is_empty() {
        body_parts.push(stdout_stats.captured.trim().to_owned());
    }
    if !stderr_stats.captured.trim().is_empty() {
        body_parts.push(stderr_stats.captured.trim().to_owned());
    }
    let body = body_parts.join("\n");
    Ok(ToolResult {
        summary: redact_text(&command, 320),
        location: None,
        content: body,
        status: if aborted {
            "aborted"
        } else if timed_out {
            "timeout"
        } else if success {
            "success"
        } else {
            "runtime_error"
        }
        .into(),
        code: if aborted {
            Some("aborted".into())
        } else if timed_out {
            Some("process_timeout".into())
        } else if success {
            None
        } else {
            Some("command_exit_nonzero".into())
        },
        error_message: if aborted {
            Some("Command was aborted.".into())
        } else if timed_out {
            Some(format!("Command timed out after {requested} ms."))
        } else if success {
            None
        } else {
            Some(format!(
                "Command exited with code {}.",
                exit.map_or_else(|| "unknown".into(), |value| value.to_string())
            ))
        },
        exit_code: exit,
        details: Some(json!({
            "capturedBytes": captured_bytes,
            "originalBytes": original_bytes,
            "captureTruncated": capture_truncated,
            "contextHash": context_hash,
            "timeoutMs": requested,
        })),
        continuation: context_hash.map(|hash| json!({ "hash": hash })),
    })
}

#[derive(Clone, Default)]
struct StreamCapture {
    captured: String,
    original_bytes: usize,
    capture_truncated: bool,
}

async fn collect_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    sink: EventSink,
    task_id: String,
    call_id: String,
    stream: &'static str,
    capture: Arc<Mutex<StreamCapture>>,
) {
    let mut buffer = vec![0u8; 8192];
    let mut pending = String::new();
    let mut shown_bytes = 0usize;
    let mut last_emit = TokioInstant::now()
        .checked_sub(Duration::from_millis(PROGRESS_COALESCE_MS))
        .unwrap_or_else(TokioInstant::now);
    let mut original_bytes = 0usize;

    let flush = |pending: &mut String,
                 shown_bytes: &mut usize,
                 last_emit: &mut TokioInstant,
                 original_bytes: usize,
                 force: bool| {
        if pending.is_empty() {
            return;
        }
        if !force && last_emit.elapsed() < Duration::from_millis(PROGRESS_COALESCE_MS) {
            return;
        }
        if *shown_bytes >= MAX_UI_OUTPUT_BYTES {
            pending.clear();
            return;
        }
        let text = std::mem::take(pending);
        let mut end = text.len().min(MAX_UI_OUTPUT_BYTES - *shown_bytes);
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        let shown = &text[..end];
        if shown.is_empty() {
            return;
        }
        *shown_bytes += shown.len();
        *last_emit = TokioInstant::now();
        sink.emit(json!({
            "type":"tool.output",
            "taskId":task_id,
            "toolCallId":call_id,
            "stream":stream,
            "text":shown,
            "redacted":true,
            "originalBytes":original_bytes,
            "shownBytes":*shown_bytes,
            "truncated":false,
            "at":now_iso()
        }));
    };

    while let Ok(count) = reader.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        let text = redact_stream_text(&String::from_utf8_lossy(&buffer[..count]), 64 * 1024);
        if text.is_empty() {
            continue;
        }
        if let Ok(mut state) = capture.lock() {
            state.original_bytes = state.original_bytes.saturating_add(text.len());
            append_tail(&mut state.captured, &text, MAX_CAPTURED_OUTPUT_BYTES);
            state.capture_truncated = state.original_bytes > state.captured.len();
            original_bytes = state.original_bytes;
        }
        pending.push_str(&text);
        if pending.len() >= 1024
            || last_emit.elapsed() >= Duration::from_millis(PROGRESS_COALESCE_MS)
        {
            flush(
                &mut pending,
                &mut shown_bytes,
                &mut last_emit,
                original_bytes,
                false,
            );
        }
    }
    flush(
        &mut pending,
        &mut shown_bytes,
        &mut last_emit,
        original_bytes,
        true,
    );
    if original_bytes > shown_bytes {
        sink.emit(json!({
            "type":"tool.output",
            "taskId":task_id,
            "toolCallId":call_id,
            "stream":stream,
            "text":format!("\n...[output preview truncated: shownBytes={shown_bytes} originalBytes={original_bytes}]"),
            "redacted":true,
            "originalBytes":original_bytes,
            "shownBytes":shown_bytes,
            "truncated":true,
            "at":now_iso()
        }));
    }
}

fn append_tail(buffer: &mut String, chunk: &str, limit: usize) {
    if chunk.is_empty() {
        return;
    }
    buffer.push_str(chunk);
    if buffer.len() <= limit {
        return;
    }
    let mut start = buffer.len() - limit;
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }
    let tail = buffer[start..].to_owned();
    *buffer = tail;
}

fn protected_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper == "UMBRATIC_RUNNER_CONFIG"
        || upper == "SSH_AUTH_SOCK"
        || [
            "API_KEY",
            "APIKEY",
            "AUTHORIZATION",
            "BEARER",
            "PASSWORD",
            "PASSWD",
            "COOKIE",
            "CREDENTIAL",
            "SECRET",
            "TOKEN",
        ]
        .iter()
        .any(|marker| upper.contains(marker))
}

fn allowed_command_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "PATH"
            | "HOME"
            | "USERPROFILE"
            | "TMPDIR"
            | "TMP"
            | "TEMP"
            | "LANG"
            | "TERM"
            | "NO_PROXY"
            | "SYSTEMROOT"
            | "SYSTEMDRIVE"
            | "WINDIR"
            | "COMSPEC"
            | "PATHEXT"
            | "UV_INSTALL_DIR"
            | "UV_UNMANAGED_INSTALL"
            | "UV_NO_MODIFY_PATH"
            | "UV_PYTHON_INSTALL_DIR"
            | "UV_PYTHON_BIN_DIR"
            | "UV_CACHE_DIR"
    ) || upper.starts_with("LC_")
}

pub(super) fn filtered_command_environment<I>(values: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    values
        .into_iter()
        .filter(|(name, _)| {
            allowed_command_environment_name(name) && !protected_environment_name(name)
        })
        .collect()
}

pub(super) fn resolve_trusted_shell() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .ok_or_else(|| "SystemRoot is required to resolve a trusted PowerShell".to_owned())?;
        let candidate = PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            Ok(candidate)
        } else {
            Err(format!(
                "Trusted PowerShell was not found at {}.",
                candidate.display()
            ))
        }
    }
    #[cfg(not(windows))]
    {
        for candidate in ["/bin/sh", "/usr/bin/sh"] {
            let path = PathBuf::from(candidate);
            if path.is_file() {
                return Ok(path);
            }
        }
        Err("Trusted shell (/bin/sh) was not found.".into())
    }
}

pub(super) fn trusted_command_path() -> String {
    #[cfg(windows)]
    {
        let system_root = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("WINDIR"))
            .unwrap_or_else(|_| r"C:\Windows".into());
        let root = system_root.trim_end_matches(['\\', '/']).to_owned();
        let system32 = format!(r"{root}\System32");
        format!(r"{system32};{root};{system32}\Wbem;{system32}\WindowsPowerShell\v1.0")
    }
    #[cfg(not(windows))]
    {
        "/usr/bin:/bin:/usr/sbin:/sbin".into()
    }
}

pub(super) fn safe_command_environment() -> BTreeMap<String, String> {
    let mut env = filtered_command_environment(std::env::vars());
    // Never inherit a parent PATH that may prefer workspace-controlled runtimes.
    env.retain(|name, _| !name.eq_ignore_ascii_case("PATH"));
    env.insert("PATH".into(), trusted_command_path());
    env
}

async fn terminate_command_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The shell is launched as its own process group, matching the previous runner's tree termination semantics.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        return;
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            Command::new(
                std::path::Path::new(&root)
                    .join("System32")
                    .join("taskkill.exe"),
            )
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
        )
        .await;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = pid;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::append_tail;

    #[test]
    fn append_tail_keeps_newest_bytes() {
        let mut buffer = String::new();
        append_tail(&mut buffer, "abcdef", 4);
        assert_eq!(buffer, "cdef");
        append_tail(&mut buffer, "ghij", 4);
        assert_eq!(buffer, "ghij");
    }
}
