use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::{Duration, Instant as TokioInstant, interval, sleep_until},
};
use walkdir::WalkDir;

use crate::{
    config::PermissionMode,
    context::compress_tool_result,
    events::now_iso,
    policy::{
        confirm_workspace_write_path, is_blocked_path, is_generated_runtime_path,
        redact_stream_text, redact_text, resolve_workspace_path,
    },
    safety::{CommandPermit, SafetyAction, SafetyDecision},
    session::{EventSink, Session},
};

mod catalog;
mod command;
#[cfg(test)]
mod command_tests;
mod contract;
#[cfg(test)]
mod contract_tests;
mod dispatch;
mod enumerate;
mod error;
mod patch;
mod read;
mod request;
mod search;
mod skill;
mod surface;
mod write;

#[cfg(test)]
use crate::skill_preflight::explicit_skill_mention;
use command::command_tool;
#[cfg(test)]
use command::{
    filtered_command_environment, resolve_trusted_shell, safe_command_environment,
    trusted_command_path,
};
pub(crate) use contract::validate_tool_call_batch;
pub use dispatch::execute_tool;
use enumerate::{find_tool, grep_tool, ls_tool};
pub use error::ToolResult;
use error::{ToolError, ToolExecutionResult};
use read::{read_attachment_tool, read_tool};
#[cfg(test)]
use request::parse_arguments;
pub use request::tool_capability_name;
use request::{ToolRequest, command_display};
pub use search::SearchIndex;
use search::{note_mutation, search_tool};
use skill::read_skill_tool;
pub use surface::{ToolSurface, enabled_tool_specs, tool_surface};
use write::{apply_patch_tool, edit_tool, write_tool};

const MAX_READ_OUTPUT_BYTES: usize = 60 * 1024;
/// `read` streams and is bounded per call, so it can show any file. A mutation
/// has to hold the whole file to match exactly, so it carries its own explicit
/// bound — large enough for real source files, and named in the typed error when
/// it is exceeded rather than left as a silent mismatch with `read`.
const MAX_MUTABLE_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNK_BYTES: usize = 12 * 1024;

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub index: usize,
}

fn string_arg(input: &Map<String, Value>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| input.get(*name).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn string_list_arg(input: &Map<String, Value>, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .find_map(|name| input.get(*name))
        .map(|value| match value {
            Value::String(value) => vec![value.clone()],
            Value::Array(values) => values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        })
        .unwrap_or_default()
}

/// Reads an optional count. The generated validator has already bounded it, so
/// this only supplies the default; it never clamps.
fn number_arg(input: &Map<String, Value>, name: &str, fallback: u64) -> u64 {
    input.get(name).and_then(Value::as_u64).unwrap_or(fallback)
}

/// Rejects a glob-like `path` argument before the filesystem sees it. On
/// Windows a pattern in a path fails with a raw "The filename, directory name,
/// or volume label syntax is incorrect" OS error that names no correction, so
/// the model retries variations instead of moving the pattern where it belongs.
// Only `*` and `?` are rejected: they are never legal in Windows filenames,
// while `[` appears in real paths (Next.js route directories like `[id]`).
fn glob_free_path(tool: &str, path: &str) -> Result<(), ToolError> {
    if path.contains(['*', '?']) {
        return Err(ToolError::validation(format!(
            "{tool} path must be an exact file or directory, not a pattern. \
             Scope by directory with path, put filename patterns in a glob argument \
             (find or grep), and take paths from a listing or search result."
        )));
    }
    Ok(())
}

/// Turns a non-NotFound metadata failure into a corrective validation error
/// instead of a raw OS error string.
fn unusable_path_error(tool: &str, relative: &str, error: &std::io::Error) -> ToolError {
    ToolError::validation(format!(
        "{tool} path {relative} is not a usable file or directory ({error}). \
         Use an exact workspace path from a listing or search result."
    ))
}

fn ensure_text_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Path is not a file".into());
    }
    if metadata.len() > MAX_MUTABLE_FILE_BYTES {
        return Err(format!(
            "File is {} bytes and exceeds the {MAX_MUTABLE_FILE_BYTES}-byte limit for tools that rewrite a whole file. Use read to inspect it.",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Err("Refusing to read binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "Refusing to read non-UTF-8 file".into())
}

fn should_skip(relative: &str) -> bool {
    relative.is_empty() || is_generated_runtime_path(relative) || is_blocked_path(relative)
}

#[cfg(test)]
mod read_pdf_tests;
#[cfg(test)]
mod search_performance;
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod tests;
