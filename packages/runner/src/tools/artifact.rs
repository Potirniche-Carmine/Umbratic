//! The `artifact` tool: one entry point for creating, inspecting, and editing
//! Office and PDF files.
//!
//! Everything here is policy. The document engines live in the desktop app, and
//! this module decides what reaches them: that the action's required arguments
//! are present, that `path` and `out` are inside the workspace, that the input
//! is not larger than an engine should be asked to open, that a mutation was
//! approved, and how long the job may take. The reply is rendered for the model
//! and passed through as typed detail.
//!
//! Nothing is written on failure. The desktop stages and installs atomically,
//! and every error path here returns before a job is emitted or after one has
//! reported `ok: false`, so a failed call leaves the workspace untouched.

use std::time::Duration;

use uuid::Uuid;

use super::*;
use crate::artifact::{ArtifactFailure, artifact_timeout};

/// What an engine may be asked to open, inflated. Matches the worker's own cap;
/// stated here so an oversize file is refused before it is staged or pulled
/// over SSH.
const MAX_ARTIFACT_INPUT_BYTES: u64 = 64 * 1024 * 1024;
/// What is rendered into the model's context. The rest of a long outline stays
/// in the context store, reachable by hash through `retrieve_context`.
const MAX_ARTIFACT_SHOWN_BYTES: usize = 16 * 1024;
/// QA findings shown in full. Beyond this the model is told the count rather
/// than the list: it is going to fix errors one round at a time regardless.
const MAX_SHOWN_QA: usize = 25;

const FORMATS: [&str; 4] = ["pptx", "docx", "xlsx", "pdf"];

pub(super) async fn artifact_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let action = string_arg(input, &["action"]);
    let job = plan(session, &action, input)?;
    super::skill::require_artifact_skill(
        session,
        &action,
        job.payload["format"].as_str().unwrap_or_default(),
    )?;
    if job.mutating {
        let decision = permissions
            .request(
                sink,
                &session.task_id,
                "edit",
                &job.permission_summary,
                session.config.permission_mode == PermissionMode::AutoSafe,
            )
            .await;
        if decision == "abort" {
            return Err(ToolError::aborted(format!(
                "The tool call was aborted before the {action} ran. No file was written."
            )));
        }
        if decision != "allow" {
            return Err(ToolError::permission(format!(
                "The user rejected the {action} of {}. No file was written. Do not repeat it unless the user makes a new request that authorizes it.",
                job.display_target
            )));
        }
    }
    let reply = session
        .artifacts
        .request(sink, &session.task_id, job.payload, job.wait)
        .await
        .map_err(|failure| artifact_failure_error(failure, &action, job.wait))?;
    Ok(render(&action, &job.display_target, reply))
}

/// One validated job, ready to hand to the desktop.
#[derive(Debug)]
struct ArtifactJob {
    payload: Value,
    mutating: bool,
    /// What the permission prompt says, and what an error message names.
    permission_summary: String,
    display_target: String,
    wait: Duration,
}

/// The action matrix. The catalog has already checked that each field is
/// well-formed and within its bound; what is left is which fields this action
/// actually needs, which is a statement about the action rather than about any
/// one argument, so it lives here.
fn plan(
    session: &Session,
    action: &str,
    input: &Map<String, Value>,
) -> Result<ArtifactJob, ToolError> {
    let declared_format = input.get("format").and_then(Value::as_str);
    let path = input
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let out = input.get("out").and_then(Value::as_str).unwrap_or_default();
    let wait = artifact_timeout(
        input
            .get("options")
            .and_then(|options| options.get("timeoutMs"))
            .and_then(Value::as_u64),
    );
    let mut payload = json!({ "action": action });
    let fields = payload.as_object_mut().expect("payload is an object");

    let (mutating, display_target, permission_summary) = match action {
        "inspect" => {
            let (absolute, relative) = existing_input(session, "inspect", path)?;
            let format = resolved_format(declared_format, &relative)?;
            fields.insert("format".into(), json!(format));
            fields.insert("path".into(), json!(relative));
            fields.insert("absolutePath".into(), json!(absolute.to_string_lossy()));
            (false, relative.clone(), format!("inspect {relative}"))
        }
        "create" => {
            let format = declared_format.ok_or_else(|| {
                ToolError::validation(
                    "artifact create requires format. Send one of pptx, docx, xlsx, pdf.",
                )
            })?;
            let spec = input.get("spec").and_then(Value::as_object).ok_or_else(|| {
                ToolError::validation(
                    "artifact create requires spec, the document specification object for this format.",
                )
            })?;
            let (absolute, relative) = destination(session, format, out, spec)?;
            fields.insert("format".into(), json!(format));
            fields.insert("out".into(), json!(relative));
            fields.insert("absoluteOut".into(), json!(absolute.to_string_lossy()));
            fields.insert("spec".into(), Value::Object(spec.clone()));
            if let Some(template) = template_source(session, spec)? {
                fields.insert("templatePath".into(), json!(template));
            }
            (true, relative.clone(), format!("create {relative}"))
        }
        "edit" => {
            // Missing arguments are checked before the filesystem is touched:
            // when both are wrong, the argument the model forgot is the useful
            // half of the answer, and a path error would hide it.
            let ops = input.get("ops").and_then(Value::as_array).ok_or_else(|| {
                ToolError::validation(
                    "artifact edit requires ops, a non-empty array of operations from this file's editSurface.",
                )
            })?;
            if ops.is_empty() {
                return Err(ToolError::validation(
                    "artifact edit requires at least one op. Call inspect first and address ids from its outline.",
                ));
            }
            let (absolute, relative) = existing_input(session, "edit", path)?;
            let format = resolved_format(declared_format, &relative)?;
            // Writing back over the source is the common case and the default;
            // an explicit `out` keeps the original and is how a caller asks for
            // a copy. Either way the destination is confined the same way.
            let (absolute_out, relative_out) = if out.is_empty() {
                (absolute.clone(), relative.clone())
            } else {
                destination(session, &format, out, &Map::new())?
            };
            fields.insert("format".into(), json!(format));
            fields.insert("path".into(), json!(relative));
            fields.insert("absolutePath".into(), json!(absolute.to_string_lossy()));
            fields.insert("out".into(), json!(relative_out));
            fields.insert("absoluteOut".into(), json!(absolute_out.to_string_lossy()));
            fields.insert("ops".into(), Value::Array(ops.clone()));
            (
                true,
                relative_out.clone(),
                if relative_out == relative {
                    format!("edit {relative} ({} ops)", ops.len())
                } else {
                    format!("edit {relative} into {relative_out} ({} ops)", ops.len())
                },
            )
        }
        other => {
            return Err(ToolError::validation(format!(
                "artifact action {other} is not one of inspect, create, edit."
            )));
        }
    };

    if let Some(options) = input.get("options").and_then(Value::as_object) {
        fields.insert("options".into(), Value::Object(options.clone()));
    }
    fields.insert("timeoutMs".into(), json!(wait.as_millis() as u64));

    Ok(ArtifactJob {
        payload,
        mutating,
        permission_summary,
        display_target,
        wait,
    })
}

/// Resolves and checks a file the model says already exists.
fn existing_input(
    session: &Session,
    action: &str,
    path: &str,
) -> Result<(PathBuf, String), ToolError> {
    if path.is_empty() {
        return Err(ToolError::validation(format!(
            "artifact {action} requires path, one workspace-relative file."
        )));
    }
    glob_free_path("artifact", path)?;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, path).map_err(ToolError::policy)?;
    let metadata = fs::metadata(&absolute).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ToolError::validation(format!(
                "artifact {action} path {relative} does not exist. Use an exact path from a listing or search result."
            ))
        } else {
            unusable_path_error("artifact", &relative, &error)
        }
    })?;
    if !metadata.is_file() {
        return Err(ToolError::validation(format!(
            "artifact {action} path {relative} is a directory, not a file."
        )));
    }
    if metadata.len() > MAX_ARTIFACT_INPUT_BYTES {
        return Err(ToolError::validation_code(
            "file_too_large",
            format!(
                "artifact {action} path {relative} is {} bytes and exceeds the {MAX_ARTIFACT_INPUT_BYTES}-byte limit for document engines.",
                metadata.len()
            ),
        ));
    }
    Ok((absolute, relative))
}

/// Documents belong to the reviewable workspace, outside internal runtime state.
fn destination(
    session: &Session,
    format: &str,
    out: &str,
    spec: &Map<String, Value>,
) -> Result<(PathBuf, String), ToolError> {
    let requested = if out.is_empty() {
        format!("artifacts/{format}/{}.{format}", default_name(spec))
    } else {
        glob_free_path("artifact", out)?;
        out.to_owned()
    };
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &requested).map_err(ToolError::policy)?;
    if absolute.is_dir() {
        return Err(ToolError::validation(format!(
            "artifact out {relative} is a directory. Name the file, extension included."
        )));
    }
    // The same gate `write` passes through, applied before a job is emitted so
    // a refused destination costs nothing.
    confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    if !relative
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(format))
    {
        return Err(ToolError::validation(format!(
            "artifact out {relative} does not end in .{format}. The extension has to match the format being written."
        )));
    }
    Ok((absolute, relative))
}

/// A deck called `q3-review.pptx` is worth more to everyone than
/// `artifact-8f3c.pptx`, so the default name comes from whatever the spec calls
/// the document before it falls back to an opaque one.
fn default_name(spec: &Map<String, Value>) -> String {
    let titled = ["title", "name"]
        .iter()
        .find_map(|key| spec.get(*key).and_then(Value::as_str))
        .or_else(|| {
            spec.get("meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("title"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            spec.get("slides")
                .or_else(|| spec.get("blocks"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|first| first.get("title"))
                .and_then(Value::as_str)
        });
    let slug = titled
        .map(|title| {
            title
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .split('-')
                .filter(|part| !part.is_empty())
                .take(8)
                .collect::<Vec<_>>()
                .join("-")
        })
        .unwrap_or_default();
    if slug.is_empty() {
        format!("artifact-{}", &Uuid::new_v4().to_string()[..8])
    } else {
        slug
    }
}

/// A `template.path` in a create spec names a second input file, and an input
/// file is confined exactly like `path` is. Resolving it here rather than in
/// the worker is the difference between the policy layer knowing every file a
/// job touches and only knowing the ones named in a top-level field.
fn template_source(
    session: &Session,
    spec: &Map<String, Value>,
) -> Result<Option<String>, ToolError> {
    let Some(path) = spec
        .get("template")
        .and_then(Value::as_object)
        .and_then(|template| template.get("path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    else {
        return Ok(None);
    };
    let (absolute, _) = existing_input(session, "create", path)?;
    Ok(Some(absolute.to_string_lossy().into_owned()))
}

fn resolved_format(declared: Option<&str>, relative: &str) -> Result<String, ToolError> {
    if let Some(format) = declared {
        return Ok(format.to_owned());
    }
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if FORMATS.contains(&extension.as_str()) {
        return Ok(extension);
    }
    // Naming the legacy case is worth a branch: it is the one a user hits by
    // accident, and "send format" would be the wrong repair for it.
    let hint = match extension.as_str() {
        "ppt" | "doc" | "xls" => {
            " Legacy .ppt, .doc, and .xls files cannot be opened; save it in the modern format first."
        }
        _ => "",
    };
    Err(ToolError::validation(format!(
        "artifact cannot infer a format from {relative}. Send format explicitly, or use a .pptx, .docx, .xlsx, or .pdf file.{hint}"
    )))
}

fn artifact_failure_error(failure: ArtifactFailure, action: &str, wait: Duration) -> ToolError {
    match failure {
        ArtifactFailure::Timeout => ToolError::runtime_code(
            failure.code(),
            format!(
                "The artifact {action} did not finish within {} seconds and was cancelled. No file was written. Split the work into a smaller spec or fewer ops.",
                wait.as_secs()
            ),
        ),
        ArtifactFailure::Transport => ToolError::runtime_code(
            failure.code(),
            format!(
                "The artifact {action} lost its connection to the document engine before it finished. No file was written."
            ),
        ),
    }
}

/// Turns the desktop's reply into a tool result. `ok: false` is a failed call,
/// not a successful call describing a failure: the model repairs from
/// `errors[].path`, and a success status would put a file path in front of it
/// that does not exist.
fn render(action: &str, target: &str, reply: Value) -> ToolResult {
    let ok = reply.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        let mut result = ToolResult::failure(
            "validation_error",
            reply
                .get("kind")
                .and_then(Value::as_str)
                .map_or("artifact_rejected", |_| "artifact_rejected"),
            error_text(&reply),
        );
        result.summary = format!("artifact {action} {target}");
        result.details = Some(reply);
        return result;
    }
    let mut lines = Vec::new();
    let path = reply
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(target)
        .to_owned();
    let mut headline = path.clone();
    if let Some(bytes) = reply.get("bytes").and_then(Value::as_u64) {
        headline.push_str(&format!(" ({bytes} bytes)"));
    }
    lines.push(headline);
    if let Some(summary) = reply.get("summary").and_then(Value::as_str) {
        lines.push(summary.to_owned());
    }
    let origin = reply.get("origin").and_then(Value::as_str).unwrap_or("");
    let surface = reply
        .get("editSurface")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !origin.is_empty() || !surface.is_empty() {
        lines.push(format!("origin: {origin} · editSurface: {surface}"));
    }
    let unsupported = reply
        .get("unsupported")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !unsupported.is_empty() {
        lines.push(format!(
            "unsupported: {}",
            unsupported
                .iter()
                .map(|item| {
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    match item.get("where").and_then(Value::as_str) {
                        Some(location) => format!("{kind} ({location})"),
                        None => kind.to_owned(),
                    }
                })
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    lines.extend(qa_lines(&reply));
    if let Some(outline) = reply.get("outline")
        && let Ok(encoded) = serde_json::to_string_pretty(outline)
    {
        lines.push("outline:".to_owned());
        lines.push(encoded);
    }
    let mut content = lines.join("\n");
    if content.len() > MAX_ARTIFACT_SHOWN_BYTES {
        // Cut on a character boundary; the full reply survives in details and
        // in the context store, so this is presentation only.
        let mut cut = MAX_ARTIFACT_SHOWN_BYTES;
        while cut > 0 && !content.is_char_boundary(cut) {
            cut -= 1;
        }
        content.truncate(cut);
        content.push_str("\n… truncated; retrieve the rest by context hash.");
    }
    ToolResult::success_detailed(
        format!("artifact {action} {path}"),
        content,
        Some(reply),
        None,
    )
}

fn qa_lines(reply: &Value) -> Vec<String> {
    let findings = reply
        .get("qa")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if findings.is_empty() {
        return Vec::new();
    }
    let errors = findings
        .iter()
        .filter(|item| item.get("severity").and_then(Value::as_str) == Some("error"))
        .count();
    let mut lines = vec![format!(
        "qa: {errors} error{}, {} warning{}",
        if errors == 1 { "" } else { "s" },
        findings.len() - errors,
        if findings.len() - errors == 1 {
            ""
        } else {
            "s"
        }
    )];
    // Errors first: the loop that consumes this fixes every error before it
    // judges a warning, so ordering the list that way is the whole instruction.
    let mut ordered = findings.to_vec();
    ordered.sort_by_key(|item| {
        u8::from(item.get("severity").and_then(Value::as_str) != Some("error"))
    });
    for finding in ordered.iter().take(MAX_SHOWN_QA) {
        let text = |key: &str| finding.get(key).and_then(Value::as_str).unwrap_or_default();
        let mut line = format!(
            "- [{}] {} · {}",
            text("severity"),
            text("where"),
            text("message")
        );
        if !text("fix").is_empty() {
            line.push_str(&format!(" → {}", text("fix")));
        }
        lines.push(line);
    }
    if ordered.len() > MAX_SHOWN_QA {
        lines.push(format!(
            "- … {} more not shown",
            ordered.len() - MAX_SHOWN_QA
        ));
    }
    lines
}

fn error_text(reply: &Value) -> String {
    let errors = reply
        .get("errors")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if errors.is_empty() {
        return reply
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The document engine rejected the request and wrote nothing.")
            .to_owned();
    }
    errors
        .iter()
        .take(MAX_SHOWN_QA)
        .map(|error| {
            let path = error
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if path.is_empty() {
                message.to_owned()
            } else {
                format!("{path}: {message}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::test_session;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn create_defaults_its_destination_from_the_spec_title() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let job = plan(
            &session,
            "create",
            &args(json!({
                "action":"create","format":"pptx",
                "spec":{"format":"pptx","slides":[{"layout":"title","title":"Q3 Review: EMEA"}]}
            })),
        )
        .expect("planned");
        assert_eq!(job.payload["out"], "artifacts/pptx/q3-review-emea.pptx");
        assert!(job.mutating);
    }

    #[test]
    fn create_without_a_spec_names_the_missing_field() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let error = plan(
            &session,
            "create",
            &args(json!({"action":"create","format":"pptx"})),
        )
        .expect_err("rejected");
        assert!(error.message.contains("requires spec"));
    }

    #[test]
    fn an_out_whose_extension_disagrees_with_the_format_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let error = plan(
            &session,
            "create",
            &args(json!({
                "action":"create","format":"pptx","out":"decks/notes.txt",
                "spec":{"format":"pptx"}
            })),
        )
        .expect_err("rejected");
        assert!(error.message.contains("does not end in .pptx"));
    }

    #[test]
    fn inspect_infers_the_format_from_the_extension() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        std::fs::write(directory.path().join("brief.docx"), b"stub").unwrap();
        let job = plan(
            &session,
            "inspect",
            &args(json!({"action":"inspect","path":"brief.docx"})),
        )
        .expect("planned");
        assert_eq!(job.payload["format"], "docx");
        assert!(!job.mutating);
    }

    #[test]
    fn a_legacy_extension_says_what_to_do_about_it() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        std::fs::write(directory.path().join("old.doc"), b"stub").unwrap();
        let error = plan(
            &session,
            "inspect",
            &args(json!({"action":"inspect","path":"old.doc"})),
        )
        .expect_err("rejected");
        assert!(error.message.contains("save it in the modern format"));
    }

    #[test]
    fn edit_writes_back_over_its_source_unless_out_says_otherwise() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        std::fs::write(directory.path().join("deck.pptx"), b"stub").unwrap();
        let job = plan(
            &session,
            "edit",
            &args(json!({
                "action":"edit","path":"deck.pptx",
                "ops":[{"op":"replaceText","slide":1,"shape":"Title 1","text":"New"}]
            })),
        )
        .expect("planned");
        assert_eq!(job.payload["out"], "deck.pptx");
        assert!(job.mutating);
    }

    #[test]
    fn a_path_outside_the_workspace_never_reaches_a_job() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let error = plan(
            &session,
            "inspect",
            &args(json!({"action":"inspect","path":"../outside.pptx"})),
        )
        .expect_err("rejected");
        assert_eq!(error.status, "policy_blocked");
    }

    #[test]
    fn a_rejected_build_is_a_failed_call_carrying_the_json_paths_to_repair() {
        let result = render(
            "create",
            ".umbratic/artifacts/pptx/deck.pptx",
            json!({"ok":false,"errors":[{"path":"slides[3].bullets","message":"7 items; max 6"}]}),
        );
        assert_eq!(result.status, "validation_error");
        assert!(result.content.contains("slides[3].bullets"));
    }

    #[test]
    fn qa_errors_are_listed_before_warnings() {
        let result = render(
            "create",
            "deck.pptx",
            json!({"ok":true,"path":"deck.pptx","bytes":1,"qa":[
                {"severity":"warning","where":"slide 2","message":"tight"},
                {"severity":"error","where":"slide 4","message":"overflow","fix":"split"}
            ]}),
        );
        let errors_at = result.content.find("[error]").expect("error line");
        let warning_at = result.content.find("[warning]").expect("warning line");
        assert!(errors_at < warning_at);
        assert!(result.content.contains("qa: 1 error, 1 warning"));
    }
}
