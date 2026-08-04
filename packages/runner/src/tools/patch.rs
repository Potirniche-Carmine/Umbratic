use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use super::ensure_text_file;
use crate::{
    policy::{confirm_workspace_write_path, resolve_workspace_path},
    session::Session,
};

const MAX_PATCH_DIFF_BYTES: usize = 16 * 1024;

type PatchLine = (String, &'static str);
type HunkLine = (char, String, &'static str);

#[derive(Debug)]
enum PatchOperation {
    Add(String, Vec<PatchLine>),
    Delete(String),
    Update(String, Option<String>, Vec<Vec<HunkLine>>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SourceSnapshot {
    Missing,
    Text(String),
}

#[derive(Debug)]
struct PlannedChange {
    path: PathBuf,
    content: Option<String>,
}

#[derive(Debug)]
struct SnapshotRecord {
    path: PathBuf,
    relative: String,
    expected: SourceSnapshot,
}

#[derive(Debug)]
pub(super) struct PatchEffect {
    pub(super) path: String,
    pub(super) action: &'static str,
    pub(super) summary: String,
}

#[derive(Debug)]
pub(super) struct PatchCommitResult {
    pub(super) effects: Vec<PatchEffect>,
    pub(super) diff: String,
}

#[derive(Debug)]
pub(super) enum PatchCommitError {
    Failed { message: String },
    RollbackFailed { message: String },
}

#[derive(Debug)]
pub(super) struct PatchTransaction {
    changes: Vec<PlannedChange>,
    summaries: Vec<String>,
    effects: Vec<PatchEffect>,
    snapshots: Vec<SnapshotRecord>,
    before_contents: Vec<(String, Option<String>)>,
    after_contents: Vec<(String, Option<String>)>,
}

impl PatchTransaction {
    pub(super) fn summaries(&self) -> &[String] {
        &self.summaries
    }

    pub(super) fn revalidate(&self) -> Result<(), String> {
        for snapshot in &self.snapshots {
            let current = read_snapshot(&snapshot.path)?;
            if current != snapshot.expected {
                return Err(format!(
                    "Patch source changed externally for {}. Re-read and retry; no mutation was applied.",
                    snapshot.relative
                ));
            }
        }
        Ok(())
    }

    fn set_change(&mut self, path: PathBuf, content: Option<String>) {
        if let Some(change) = self.changes.iter_mut().find(|change| change.path == path) {
            change.content = content;
        } else {
            self.changes.push(PlannedChange { path, content });
        }
    }

    fn planned_content(&self, path: &Path) -> Option<&Option<String>> {
        self.changes
            .iter()
            .find(|change| change.path == path)
            .map(|change| &change.content)
    }

    fn record_snapshot(
        &mut self,
        path: PathBuf,
        relative: String,
        expected: SourceSnapshot,
    ) -> Result<(), String> {
        if self
            .snapshots
            .iter()
            .any(|snapshot| snapshot.path == path && snapshot.expected != expected)
        {
            return Err(format!("Patch snapshot conflict for {relative}"));
        }
        if !self.snapshots.iter().any(|snapshot| snapshot.path == path) {
            self.snapshots.push(SnapshotRecord {
                path,
                relative,
                expected,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PatchCommitStep {
    CreateDirectory(usize),
    StageWrite(usize),
    PreserveOriginal(usize),
    InstallStaged(usize),
}

#[derive(Debug)]
struct CommitRecord {
    target: PathBuf,
    staged: Option<PathBuf>,
    backup: Option<PathBuf>,
    installed: bool,
}

/// One unique-or-reject match, byte-exact and shared by `edit` and `apply_patch`.
/// Neither tool normalizes line endings: `read` hands back the file's own bytes,
/// so a verbatim copy matches on LF, CRLF, and mixed-ending files alike.
pub(super) enum UniqueMatch {
    Missing,
    Ambiguous(usize),
}

pub(super) fn unique_match(current: &str, old: &str) -> Result<usize, UniqueMatch> {
    let matches = current.match_indices(old).collect::<Vec<_>>();
    match matches.len() {
        1 => Ok(matches[0].0),
        0 => Err(UniqueMatch::Missing),
        count => Err(UniqueMatch::Ambiguous(count)),
    }
}

pub(super) fn replace_unique(current: &str, old: &str, new: &str) -> Result<String, UniqueMatch> {
    let start = unique_match(current, old)?;
    let mut updated = String::with_capacity(current.len() - old.len() + new.len());
    updated.push_str(&current[..start]);
    updated.push_str(new);
    updated.push_str(&current[start + old.len()..]);
    Ok(updated)
}

pub(super) fn replace_unique_hunk(current: &str, old: &str, new: &str) -> Result<String, String> {
    if old.is_empty() {
        return Err("Patch hunk was empty".into());
    }
    replace_unique(current, old, new).map_err(|failure| match failure {
        UniqueMatch::Missing => "Patch hunk was not found".to_owned(),
        UniqueMatch::Ambiguous(count) => {
            format!("Patch hunk matched {count} times; each hunk must be unique")
        }
    })
}

/// Splits a patch document into `(content, terminator)` pairs without rewriting a
/// single byte, so hunk bodies keep the line endings the patch was written with.
fn patch_lines(patch: &str) -> Vec<(&str, &'static str)> {
    let mut lines = Vec::new();
    let mut rest = patch;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(index) => {
                let (line, remainder) = rest.split_at(index + 1);
                let content = line.strip_suffix('\n').unwrap_or(line);
                let (content, terminator) = match content.strip_suffix('\r') {
                    Some(trimmed) => (trimmed, "\r\n"),
                    None => (content, "\n"),
                };
                lines.push((content, terminator));
                rest = remainder;
            }
            None => {
                lines.push((rest, ""));
                rest = "";
            }
        }
    }
    lines
}

/// Concatenates parsed patch lines with their own terminators, dropping the last
/// one so the result stays an exact substring of a file whose final line is
/// unterminated.
fn joined_lines<'a>(lines: impl Iterator<Item = &'a (String, &'a str)>) -> String {
    let collected: Vec<_> = lines.collect();
    let mut joined = String::new();
    for (index, (text, _)) in collected.iter().enumerate() {
        if index > 0 {
            joined.push_str(collected[index - 1].1);
        }
        joined.push_str(text);
    }
    joined
}

pub(super) fn bounded_unified_diff(path: &str, before: &str, after: &str, limit: usize) -> String {
    let before_lines = before.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    let mut body = format!("--- a/{path}\n+++ b/{path}\n");
    let mut index = 0usize;
    let mut before_line = 1usize;
    let mut after_line = 1usize;
    while index < before_lines.len() || index < after_lines.len() {
        let left = before_lines.get(index).copied();
        let right = after_lines.get(index).copied();
        if left == right {
            index += 1;
            before_line += 1;
            after_line += 1;
            continue;
        }
        let hunk = format!(
            "@@ -{before_line},1 +{after_line},1 @@\n{}{}",
            left.map(|line| format!("-{line}\n")).unwrap_or_default(),
            right.map(|line| format!("+{line}\n")).unwrap_or_default()
        );
        if body.len() + hunk.len() > limit {
            body.push_str(&format!("...[diff truncated at {limit} bytes]\n"));
            break;
        }
        body.push_str(&hunk);
        index += 1;
        if left.is_some() {
            before_line += 1;
        }
        if right.is_some() {
            after_line += 1;
        }
    }
    body
}

fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, String> {
    let mut raw = patch_lines(patch);
    if raw.last().map(|(content, _)| content.is_empty()) == Some(true) {
        raw.pop();
    }
    let mut lines: Vec<&str> = raw.iter().map(|(content, _)| *content).collect();
    let mut endings: Vec<&'static str> = raw.iter().map(|(_, terminator)| *terminator).collect();
    if lines.first() != Some(&"*** Begin Patch") {
        return Err("Patch must start with *** Begin Patch".into());
    }
    if lines.last() != Some(&"*** End Patch") {
        return Err("Patch must end with *** End Patch".into());
    }
    lines.remove(0);
    lines.pop();
    endings.remove(0);
    endings.pop();
    let mut operations = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            index += 1;
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                let Some(value) = lines[index].strip_prefix('+') else {
                    return Err(format!("Add File lines must start with + in {path}"));
                };
                body.push((value.to_owned(), endings[index]));
                index += 1;
            }
            if body.is_empty() {
                return Err(format!("Add File requires at least one + line: {path}"));
            }
            operations.push(PatchOperation::Add(path.trim().into(), body));
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            operations.push(PatchOperation::Delete(path.trim().into()));
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            index += 1;
            let mut move_to = None;
            if index < lines.len()
                && let Some(target) = lines[index].strip_prefix("*** Move to: ")
            {
                move_to = Some(target.trim().into());
                index += 1;
            }
            let mut hunks = Vec::new();
            let mut current = Vec::new();
            while index < lines.len()
                && !lines[index].starts_with("*** Add File: ")
                && !lines[index].starts_with("*** Delete File: ")
                && !lines[index].starts_with("*** Update File: ")
            {
                let value = lines[index];
                if value == "@@" || value.starts_with("@@ ") || value == "*** End of File" {
                    if !current.is_empty() {
                        hunks.push(std::mem::take(&mut current));
                    }
                    index += 1;
                    continue;
                }
                let marker = value
                    .chars()
                    .next()
                    .ok_or_else(|| "Invalid empty patch line".to_owned())?;
                if !matches!(marker, ' ' | '+' | '-') {
                    return Err(format!("Invalid patch line in {path}: {value}"));
                }
                current.push((
                    marker,
                    value[marker.len_utf8()..].to_owned(),
                    endings[index],
                ));
                index += 1;
            }
            if !current.is_empty() {
                hunks.push(current);
            }
            operations.push(PatchOperation::Update(path.trim().into(), move_to, hunks));
            continue;
        }
        return Err(format!("Unexpected patch line: {line}"));
    }
    if operations.is_empty() {
        return Err("Patch must contain at least one file operation".into());
    }
    Ok(operations)
}

fn read_snapshot(path: &Path) -> Result<SourceSnapshot, String> {
    if !path.exists() {
        return Ok(SourceSnapshot::Missing);
    }
    Ok(SourceSnapshot::Text(ensure_text_file(path)?))
}

pub(super) fn plan_patch(session: &Session, patch: &str) -> Result<PatchTransaction, String> {
    let mut transaction = PatchTransaction {
        changes: Vec::new(),
        summaries: Vec::new(),
        effects: Vec::new(),
        snapshots: Vec::new(),
        before_contents: Vec::new(),
        after_contents: Vec::new(),
    };
    for operation in parse_patch(patch)? {
        match operation {
            PatchOperation::Add(path, lines) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                transaction.record_snapshot(
                    target.clone(),
                    relative.clone(),
                    SourceSnapshot::Missing,
                )?;
                if transaction
                    .planned_content(&target)
                    .and_then(Option::as_ref)
                    .is_some()
                    || target.exists()
                {
                    return Err(format!("Patch target already exists: {relative}"));
                }
                let content = joined_lines(lines.iter());
                transaction.before_contents.push((relative.clone(), None));
                transaction
                    .after_contents
                    .push((relative.clone(), Some(content.clone())));
                transaction.set_change(target, Some(content));
                transaction.summaries.push(format!("added {relative}"));
                transaction.effects.push(PatchEffect {
                    path: relative,
                    action: "added",
                    summary: "added".into(),
                });
            }
            PatchOperation::Delete(path) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                let existing = match transaction.planned_content(&target) {
                    Some(Some(value)) => value.clone(),
                    Some(None) => {
                        return Err(format!("Patch delete target was not found: {relative}"));
                    }
                    None => {
                        let content = ensure_text_file(&target)?;
                        transaction.record_snapshot(
                            target.clone(),
                            relative.clone(),
                            SourceSnapshot::Text(content.clone()),
                        )?;
                        content
                    }
                };
                transaction
                    .before_contents
                    .push((relative.clone(), Some(existing)));
                transaction.after_contents.push((relative.clone(), None));
                transaction.set_change(target, None);
                transaction.summaries.push(format!("deleted {relative}"));
                transaction.effects.push(PatchEffect {
                    path: relative.clone(),
                    action: "deleted",
                    summary: format!("deleted {relative}"),
                });
            }
            PatchOperation::Update(path, move_to, hunks) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                let mut content = match transaction.planned_content(&target) {
                    Some(Some(value)) => value.clone(),
                    Some(None) => {
                        return Err(format!("Patch update target was not found: {relative}"));
                    }
                    None => {
                        let content = ensure_text_file(&target)?;
                        transaction.record_snapshot(
                            target.clone(),
                            relative.clone(),
                            SourceSnapshot::Text(content.clone()),
                        )?;
                        content
                    }
                };
                let before = content.clone();
                for hunk in hunks {
                    let kept: Vec<PatchLine> = hunk
                        .iter()
                        .filter(|(kind, _, _)| *kind != '+')
                        .map(|(_, line, terminator)| (line.clone(), *terminator))
                        .collect();
                    let replacement: Vec<PatchLine> = hunk
                        .iter()
                        .filter(|(kind, _, _)| *kind != '-')
                        .map(|(_, line, terminator)| (line.clone(), *terminator))
                        .collect();
                    let old = joined_lines(kept.iter());
                    let new = joined_lines(replacement.iter());
                    if old == new {
                        continue;
                    }
                    content = replace_unique_hunk(&content, &old, &new)
                        .map_err(|error| format!("{error} in {relative}"))?;
                }
                if let Some(destination) = move_to {
                    let (moved, moved_relative) =
                        resolve_workspace_path(&session.config.cwd, &destination)?;
                    transaction.record_snapshot(
                        moved.clone(),
                        moved_relative.clone(),
                        SourceSnapshot::Missing,
                    )?;
                    if moved != target
                        && (moved.exists() || transaction.planned_content(&moved).is_some())
                    {
                        return Err(format!("Patch target already exists: {moved_relative}"));
                    }
                    transaction
                        .before_contents
                        .push((relative.clone(), Some(before)));
                    transaction.after_contents.push((relative.clone(), None));
                    transaction
                        .before_contents
                        .push((moved_relative.clone(), None));
                    transaction
                        .after_contents
                        .push((moved_relative.clone(), Some(content.clone())));
                    transaction.set_change(target, None);
                    transaction.set_change(moved, Some(content));
                    transaction
                        .summaries
                        .push(format!("renamed {relative} -> {moved_relative}"));
                    transaction.effects.push(PatchEffect {
                        path: moved_relative.clone(),
                        action: "renamed",
                        summary: format!("renamed {relative} -> {moved_relative}"),
                    });
                } else {
                    transaction
                        .before_contents
                        .push((relative.clone(), Some(before)));
                    transaction
                        .after_contents
                        .push((relative.clone(), Some(content.clone())));
                    transaction.set_change(target, Some(content));
                    transaction.summaries.push(format!("modified {relative}"));
                    transaction.effects.push(PatchEffect {
                        path: relative.clone(),
                        action: "modified",
                        summary: format!("modified {relative}"),
                    });
                }
            }
        }
    }
    // Fix effect summaries to include path for add
    for effect in &mut transaction.effects {
        if effect.action == "added" && effect.summary == "added" {
            effect.summary = format!("added {}", effect.path);
        }
    }
    Ok(transaction)
}

pub(super) fn commit_patch(
    root: &Path,
    transaction: PatchTransaction,
) -> Result<PatchCommitResult, PatchCommitError> {
    let effects = transaction.effects;
    let mut diff = String::new();
    for ((path, before), (_, after)) in transaction
        .before_contents
        .iter()
        .zip(transaction.after_contents.iter())
    {
        let before_text = before.as_deref().unwrap_or("");
        let after_text = after.as_deref().unwrap_or("");
        if before_text == after_text {
            continue;
        }
        let chunk = bounded_unified_diff(path, before_text, after_text, MAX_PATCH_DIFF_BYTES);
        if diff.len() + chunk.len() > MAX_PATCH_DIFF_BYTES {
            diff.push_str(&format!(
                "...[patch diff truncated at {MAX_PATCH_DIFF_BYTES} bytes]\n"
            ));
            break;
        }
        if !diff.is_empty() {
            diff.push('\n');
        }
        diff.push_str(&chunk);
    }
    commit_patch_with_hook(root, transaction.changes, |_| Ok(()))?;
    Ok(PatchCommitResult { effects, diff })
}

fn commit_patch_with_hook<F>(
    root: &Path,
    changes: Vec<PlannedChange>,
    mut before_step: F,
) -> Result<(), PatchCommitError>
where
    F: FnMut(PatchCommitStep) -> Result<(), String>,
{
    let (changes, directories) = validate_transaction(root, changes)
        .map_err(|message| PatchCommitError::Failed { message })?;
    let mut created_directories = Vec::new();
    let mut records = changes
        .iter()
        .map(|change| CommitRecord {
            target: change.path.clone(),
            staged: None,
            backup: None,
            installed: false,
        })
        .collect::<Vec<_>>();

    for (index, directory) in directories.iter().enumerate() {
        if let Err(error) = before_step(PatchCommitStep::CreateDirectory(index))
            .and_then(|_| fs::create_dir(directory).map_err(|error| error.to_string()))
        {
            cleanup_staging(&records, &created_directories);
            return Err(PatchCommitError::Failed {
                message: format!("Patch staging failed: {error}"),
            });
        }
        created_directories.push(directory.clone());
    }

    for (index, change) in changes.iter().enumerate() {
        let Some(content) = &change.content else {
            continue;
        };
        if let Err(error) = before_step(PatchCommitStep::StageWrite(index)).and_then(|_| {
            let staged = unique_sibling_path(root, &change.path, "staged")?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staged)
                .map_err(|error| error.to_string())?;
            if let Err(error) = file
                .write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
            {
                let _ = fs::remove_file(&staged);
                return Err(error.to_string());
            }
            records[index].staged = Some(staged);
            Ok(())
        }) {
            cleanup_staging(&records, &created_directories);
            return Err(PatchCommitError::Failed {
                message: format!("Patch staging failed: {error}"),
            });
        }
    }

    for index in 0..changes.len() {
        let result = apply_change(root, index, &mut records[index], &mut before_step);
        if let Err(error) = result {
            let rollback_errors = rollback(&mut records, &created_directories);
            return if rollback_errors.is_empty() {
                Err(PatchCommitError::Failed {
                    message: format!(
                        "Patch commit failed and all changes were rolled back: {error}"
                    ),
                })
            } else {
                Err(PatchCommitError::RollbackFailed {
                    message: format!(
                        "Patch commit failed: {error}. Rollback also failed: {}",
                        rollback_errors.join("; ")
                    ),
                })
            };
        }
    }

    for record in &records {
        if let Some(backup) = &record.backup {
            let _ = fs::remove_file(backup);
        }
    }
    Ok(())
}

fn validate_transaction(
    root: &Path,
    changes: Vec<PlannedChange>,
) -> Result<(Vec<PlannedChange>, Vec<PathBuf>), String> {
    let mut validated = Vec::with_capacity(changes.len());
    let mut directories = Vec::new();
    for change in changes {
        let target = confirm_workspace_write_path(root, &change.path)?;
        if target.exists() {
            let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err(format!("Patch target is not a file: {}", target.display()));
            }
        }
        let parent = target
            .parent()
            .ok_or_else(|| "Patch target does not have a parent directory".to_owned())?;
        let validated_parent = confirm_workspace_write_path(root, parent)?;
        collect_missing_directories(&validated_parent, &mut directories)?;
        validated.push(PlannedChange {
            path: target,
            content: change.content,
        });
    }
    Ok((validated, directories))
}

fn collect_missing_directories(
    parent: &Path,
    directories: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut cursor = parent.to_path_buf();
    let mut missing = Vec::new();
    while !cursor.exists() {
        missing.push(cursor.clone());
        if !cursor.pop() {
            return Err("Unable to resolve patch parent directory".into());
        }
    }
    if !fs::metadata(&cursor)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err(format!(
            "Patch parent is not a directory: {}",
            cursor.display()
        ));
    }
    for directory in missing.into_iter().rev() {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    Ok(())
}

fn unique_sibling_path(root: &Path, target: &Path, kind: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Patch target does not have a parent directory".to_owned())?;
    loop {
        let candidate = parent.join(format!(".umbratic-patch-{}-{kind}", Uuid::new_v4()));
        let candidate = confirm_workspace_write_path(root, &candidate)?;
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
}

fn apply_change<F>(
    root: &Path,
    index: usize,
    record: &mut CommitRecord,
    before_step: &mut F,
) -> Result<(), String>
where
    F: FnMut(PatchCommitStep) -> Result<(), String>,
{
    if record.target.exists() {
        before_step(PatchCommitStep::PreserveOriginal(index))?;
        let backup = unique_sibling_path(root, &record.target, "backup")?;
        fs::rename(&record.target, &backup).map_err(|error| error.to_string())?;
        record.backup = Some(backup);
    }
    if let Some(staged) = record.staged.clone() {
        before_step(PatchCommitStep::InstallStaged(index))?;
        fs::rename(&staged, &record.target).map_err(|error| error.to_string())?;
        record.staged = None;
        record.installed = true;
    }
    Ok(())
}

fn cleanup_staging(records: &[CommitRecord], created_directories: &[PathBuf]) {
    for record in records {
        if let Some(staged) = &record.staged {
            let _ = fs::remove_file(staged);
        }
    }
    for directory in created_directories.iter().rev() {
        let _ = fs::remove_dir(directory);
    }
}

fn rollback(records: &mut [CommitRecord], created_directories: &[PathBuf]) -> Vec<String> {
    let mut errors = Vec::new();
    for record in records.iter_mut().rev() {
        if record.installed && record.target.exists() {
            if let Err(error) = fs::remove_file(&record.target) {
                errors.push(error.to_string());
                continue;
            }
            record.installed = false;
        }
        if let Some(backup) = record.backup.take()
            && let Err(error) = fs::rename(&backup, &record.target)
        {
            errors.push(error.to_string());
        }
        if let Some(staged) = record.staged.take() {
            let _ = fs::remove_file(staged);
        }
    }
    for directory in created_directories.iter().rev() {
        if let Err(error) = fs::remove_dir(directory) {
            errors.push(error.to_string());
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::*;

    const COMPLEX_PATCH: &str = "*** Begin Patch
*** Update File: update.txt
@@
-before
+after
*** Delete File: delete.txt
*** Add File: nested/added.txt
+new
*** Update File: move.txt
*** Move to: moved.txt
@@
-move before
+move after
*** End Patch";

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("update.txt"), "before\n").unwrap();
        fs::write(directory.path().join("delete.txt"), "delete\n").unwrap();
        fs::write(directory.path().join("move.txt"), "move before\n").unwrap();
        directory
    }

    fn assert_original_state(root: &Path) {
        assert_eq!(
            fs::read_to_string(root.join("update.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("delete.txt")).unwrap(),
            "delete\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("move.txt")).unwrap(),
            "move before\n"
        );
        assert!(!root.join("moved.txt").exists());
        assert!(!root.join("nested").exists());
        assert_no_transaction_files(root);
    }

    fn assert_no_transaction_files(root: &Path) {
        for entry in walkdir::WalkDir::new(root) {
            let entry = entry.unwrap();
            assert!(
                !entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".umbratic-patch-"),
                "transaction file was not removed: {}",
                entry.path().display()
            );
        }
    }

    #[test]
    fn parser_rejects_malformed_input() {
        assert!(parse_patch("not a patch").is_err());
    }

    #[test]
    fn unique_hunk_rejects_ambiguous_matches() {
        let current = "alpha\nalpha\n";
        let error = replace_unique_hunk(current, "alpha", "beta").unwrap_err();
        assert!(error.contains("matched 2 times"));
    }

    #[test]
    fn every_target_mutation_failure_rolls_back_the_transaction() {
        let failure_steps = [
            PatchCommitStep::PreserveOriginal(0),
            PatchCommitStep::InstallStaged(0),
            PatchCommitStep::PreserveOriginal(1),
            PatchCommitStep::InstallStaged(2),
            PatchCommitStep::PreserveOriginal(3),
            PatchCommitStep::InstallStaged(4),
        ];
        for failure_step in failure_steps {
            let directory = fixture();
            let session = crate::session::test_session(directory.path());
            let transaction = plan_patch(&session, COMPLEX_PATCH).unwrap();
            let result = commit_patch_with_hook(directory.path(), transaction.changes, |step| {
                if step == failure_step {
                    Err(format!("injected failure at {step:?}"))
                } else {
                    Ok(())
                }
            });
            assert!(
                result.is_err(),
                "failure was not injected at {failure_step:?}"
            );
            assert_original_state(directory.path());
        }
    }

    #[test]
    fn staged_write_failure_does_not_mutate_targets() {
        let directory = fixture();
        let session = crate::session::test_session(directory.path());
        let transaction = plan_patch(&session, COMPLEX_PATCH).unwrap();
        let result = commit_patch_with_hook(directory.path(), transaction.changes, |step| {
            if step == PatchCommitStep::StageWrite(2) {
                Err("injected staged write failure".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_original_state(directory.path());
    }

    #[test]
    fn directory_creation_failure_does_not_mutate_targets() {
        let directory = fixture();
        let session = crate::session::test_session(directory.path());
        let transaction = plan_patch(&session, COMPLEX_PATCH).unwrap();
        let result = commit_patch_with_hook(directory.path(), transaction.changes, |step| {
            if step == PatchCommitStep::CreateDirectory(0) {
                Err("injected directory creation failure".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_original_state(directory.path());
    }
}
