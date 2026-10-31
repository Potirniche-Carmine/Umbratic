//! Ordering rules for one batch of model tool calls.
//!
//! A batch is split into segments that may run concurrently. Commands,
//! programs, and patches are global barriers. Search is a barrier only when
//! the same batch also writes or runs a command. Two calls touching the same
//! path where either writes are separated. Everything else runs in parallel.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use futures_util::future::join_all;
use serde_json::Value;

use crate::{
    permission::PermissionBroker,
    session::{EventSink, Session},
    tools::{ToolCall, ToolResult, execute_tool},
};

pub(crate) async fn execute_calls(
    session: Arc<Session>,
    sink: EventSink,
    permissions: Arc<PermissionBroker>,
    calls: Vec<ToolCall>,
) -> Vec<ToolResult> {
    let segments = execution_segments(&session, &calls);
    let mut results: Vec<Option<ToolResult>> = vec![None; calls.len()];
    for indices in segments {
        let futures = indices.iter().map(|index| {
            execute_tool(
                session.clone(),
                sink.clone(),
                permissions.clone(),
                calls[*index].clone(),
            )
        });
        let completed = join_all(futures).await;
        for (index, result) in indices.into_iter().zip(completed) {
            results[index] = Some(result);
        }
    }
    results.into_iter().map(Option::unwrap).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolAccess {
    Free,
    Global,
    Path { path: PathBuf, write: bool },
}

fn batch_mutates(calls: &[ToolCall]) -> bool {
    calls.iter().any(|call| {
        matches!(
            call.name.as_str(),
            "command" | "run_program" | "apply_patch" | "write" | "edit" | "generate_image"
        )
    })
}

fn tool_access_in_batch(session: &Session, call: &ToolCall, batch_mutates: bool) -> ToolAccess {
    // Commands, programs, and patches are unbounded filesystem effects.
    // `search` only races a write in the same batch: it reads a session-wide
    // index that those mutations can invalidate. Alongside reads it can run
    // concurrently.
    if matches!(
        call.name.as_str(),
        "command" | "run_program" | "apply_patch"
    ) {
        return ToolAccess::Global;
    }
    if call.name == "search" {
        return if batch_mutates {
            ToolAccess::Global
        } else {
            ToolAccess::Free
        };
    }
    let write = matches!(call.name.as_str(), "write" | "edit" | "generate_image");
    if !write && !matches!(call.name.as_str(), "read" | "lsp") {
        return ToolAccess::Free;
    }
    let arguments = call.arguments.as_object().cloned().or_else(|| {
        call.arguments
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| value.as_object().cloned())
    });
    let Some(path) = arguments
        .as_ref()
        .and_then(|value| value.get("path"))
        .and_then(Value::as_str)
    else {
        return ToolAccess::Global;
    };
    crate::policy::resolve_workspace_path(&session.config.cwd, path)
        .map(|(path, _)| ToolAccess::Path { path, write })
        .unwrap_or(ToolAccess::Global)
}

pub(crate) fn execution_segments(session: &Session, calls: &[ToolCall]) -> Vec<Vec<usize>> {
    let mut segments = Vec::new();
    let mut current = Vec::new();
    let mut locks = BTreeMap::<PathBuf, bool>::new();
    let mutating = batch_mutates(calls);
    let flush = |segments: &mut Vec<Vec<usize>>,
                 current: &mut Vec<usize>,
                 locks: &mut BTreeMap<PathBuf, bool>| {
        if !current.is_empty() {
            segments.push(std::mem::take(current));
        }
        locks.clear();
    };
    for (index, call) in calls.iter().enumerate() {
        match tool_access_in_batch(session, call, mutating) {
            ToolAccess::Global => {
                flush(&mut segments, &mut current, &mut locks);
                segments.push(vec![index]);
            }
            ToolAccess::Free => current.push(index),
            ToolAccess::Path { path, write } => {
                if locks
                    .get(&path)
                    .is_some_and(|existing_write| *existing_write || write)
                {
                    flush(&mut segments, &mut current, &mut locks);
                }
                locks
                    .entry(path)
                    .and_modify(|value| *value |= write)
                    .or_insert(write);
                current.push(index);
            }
        }
    }
    flush(&mut segments, &mut current, &mut locks);
    segments
}
