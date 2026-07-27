use super::*;

pub(super) async fn command_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
    call_id: &str,
    safety: &SafetyDecisionV1,
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
        "schemaVersion": safety.schema_version,
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
        "evaluationMicros": safety.evaluation_micros,
        "at": now_iso(),
    }));
    if safety.action == SafetyAction::Deny {
        return Err(ToolError::policy(format!(
            "Command blocked by policy: {}",
            safety.explanation
        )));
    }
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
    if decision != "allow" {
        return Err(ToolError::permission("Command denied."));
    }
    let permit = CommandPermit::new(safety);
    let requested = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10 * 60 * 1000)
        .clamp(100, 30 * 60 * 1000);
    let mut process = if !program_id.is_empty() {
        let configured = session
            .config
            .approved_executables
            .get(&program_id)
            .ok_or_else(|| {
                ToolError::policy(format!("Executable {program_id} is not approved."))
            })?;
        let executable = configured.canonicalize().map_err(|_| {
            ToolError::policy(format!("Approved executable {program_id} is unavailable."))
        })?;
        if &executable != configured || !executable.is_file() {
            return Err(ToolError::policy(format!(
                "Approved executable {program_id} changed after startup."
            )));
        }
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
    permit
        .consume(&command, &session.config.cwd)
        .map_err(ToolError::policy)?;
    process
        .current_dir(&session.config.cwd)
        .env_clear()
        .envs(safe_command_environment())
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
    async fn collect_stream<R: AsyncRead + Unpin>(
        mut reader: R,
        sink: EventSink,
        task_id: String,
        call_id: String,
        stream: &'static str,
    ) -> String {
        const MAX_UI_OUTPUT_BYTES: usize = 16 * 1024;
        const MAX_CAPTURED_OUTPUT_BYTES: usize = 512 * 1024;
        let mut collected = String::new();
        let mut total_bytes = 0usize;
        let mut shown_bytes = 0usize;
        let mut buffer = vec![0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            let text = redact_stream_text(&String::from_utf8_lossy(&buffer[..count]), 64 * 1024);
            total_bytes = total_bytes.saturating_add(text.len());
            if collected.len() < MAX_CAPTURED_OUTPUT_BYTES {
                let mut end = text.len().min(MAX_CAPTURED_OUTPUT_BYTES - collected.len());
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                collected.push_str(&text[..end]);
            }
            if !text.is_empty() && shown_bytes < MAX_UI_OUTPUT_BYTES {
                let mut end = text.len().min(MAX_UI_OUTPUT_BYTES - shown_bytes);
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                let shown = &text[..end];
                shown_bytes += shown.len();
                if !shown.is_empty() {
                    sink.emit(json!({ "type":"tool.output", "taskId":task_id, "toolCallId":call_id, "stream":stream, "text":shown, "redacted":true, "originalBytes":total_bytes, "shownBytes":shown_bytes, "truncated":false, "at":now_iso() }));
                }
            }
        }
        if total_bytes > shown_bytes {
            let marker = format!(
                "\n...[output preview truncated: shownBytes={shown_bytes} originalBytes={total_bytes}]"
            );
            sink.emit(json!({ "type":"tool.output", "taskId":task_id, "toolCallId":call_id, "stream":stream, "text":marker, "redacted":true, "originalBytes":total_bytes, "shownBytes":shown_bytes, "truncated":true, "at":now_iso() }));
        }
        if total_bytes > collected.len() {
            collected.push_str(&format!(
                "\n...[captured output truncated: storedBytes={} originalBytes={total_bytes}]",
                collected.len()
            ));
        }
        collected
    }
    let stdout_task = tokio::spawn(collect_stream(
        stdout,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stdout",
    ));
    let stderr_task = tokio::spawn(collect_stream(
        stderr,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stderr",
    ));
    let deadline = TokioInstant::now() + Duration::from_millis(requested);
    let mut abort_poll = interval(Duration::from_millis(25));
    let mut timed_out = false;
    let mut aborted = false;
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.map_err(|error| error.to_string())?,
            _ = sleep_until(deadline) => { timed_out = true; terminate_command_tree(&mut child, pid).await; break child.wait().await.map_err(|error| error.to_string())?; },
            _ = abort_poll.tick() => if session.is_aborted() { aborted = true; terminate_command_tree(&mut child, pid).await; break child.wait().await.map_err(|error| error.to_string())?; }
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let exit = status.code();
    let success = status.success() && !timed_out && !aborted;
    let body = [
        format!(
            "exitCode={}",
            exit.map_or_else(|| "unknown".into(), |value| value.to_string())
        ),
        stdout.trim().to_owned(),
        stderr.trim().to_owned(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    Ok(ToolResult {
        title: redact_text(&command, 320),
        output: body,
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
        error_code: if aborted {
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
        details: None,
    })
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
        return;
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.kill().await;
}
