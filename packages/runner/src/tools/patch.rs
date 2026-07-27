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

#[derive(Debug)]
enum PatchOperation {
    Add(String, Vec<String>),
    Delete(String),
    Update(String, Option<String>, Vec<Vec<(char, String)>>),
}

#[derive(Debug)]
struct PlannedChange {
    path: PathBuf,
    content: Option<String>,
}

#[derive(Debug)]
pub(super) struct PatchTransaction {
    changes: Vec<PlannedChange>,
    summaries: Vec<String>,
}

impl PatchTransaction {
    pub(super) fn summaries(&self) -> &[String] {
        &self.summaries
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

pub(super) fn normalized_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn preferred_line_ending(value: &str) -> &'static str {
    if value.contains("\r\n") {
        "\r\n"
    } else if value.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}

fn with_line_endings(value: &str, line_ending: &str) -> String {
    normalized_line_endings(value).replace('\n', line_ending)
}

pub(super) fn replace_text_block(current: &str, old: &str, new: &str) -> Option<String> {
    let line_ending = preferred_line_ending(current);
    let replacement = with_line_endings(new, line_ending);
    if current.contains(old) {
        return Some(current.replacen(old, &replacement, 1));
    }
    let old = with_line_endings(old, line_ending);
    current
        .contains(&old)
        .then(|| current.replacen(&old, &replacement, 1))
}

fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, String> {
    let normalized = normalized_line_endings(patch);
    let mut lines: Vec<_> = normalized.lines().collect();
    if lines.first() != Some(&"*** Begin Patch") {
        return Err("Patch must start with *** Begin Patch".into());
    }
    if lines.last() != Some(&"*** End Patch") {
        return Err("Patch must end with *** End Patch".into());
    }
    lines.remove(0);
    lines.pop();
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
                body.push(value.to_owned());
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
                current.push((marker, value[marker.len_utf8()..].to_owned()));
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

pub(super) fn plan_patch(session: &Session, patch: &str) -> Result<PatchTransaction, String> {
    let mut transaction = PatchTransaction {
        changes: Vec::new(),
        summaries: Vec::new(),
    };
    for operation in parse_patch(patch)? {
        match operation {
            PatchOperation::Add(path, lines) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                if transaction
                    .planned_content(&target)
                    .and_then(Option::as_ref)
                    .is_some()
                    || target.exists()
                {
                    return Err(format!("Patch target already exists: {relative}"));
                }
                transaction.set_change(target, Some(lines.join("\n")));
                transaction.summaries.push(format!("added {relative}"));
            }
            PatchOperation::Delete(path) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                if !target.exists() && transaction.planned_content(&target).is_none() {
                    return Err(format!("Patch delete target was not found: {relative}"));
                }
                transaction.set_change(target, None);
                transaction.summaries.push(format!("deleted {relative}"));
            }
            PatchOperation::Update(path, move_to, hunks) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                let mut content = match transaction.planned_content(&target) {
                    Some(Some(value)) => value.clone(),
                    Some(None) => {
                        return Err(format!("Patch update target was not found: {relative}"));
                    }
                    None => ensure_text_file(&target)?,
                };
                for hunk in hunks {
                    let old = hunk
                        .iter()
                        .filter(|(kind, _)| *kind != '+')
                        .map(|(_, line)| line.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let new = hunk
                        .iter()
                        .filter(|(kind, _)| *kind != '-')
                        .map(|(_, line)| line.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if old == new {
                        continue;
                    }
                    if old.is_empty() {
                        return Err(format!("Patch hunk was not found in {relative}"));
                    }
                    content = replace_text_block(&content, &old, &new)
                        .ok_or_else(|| format!("Patch hunk was not found in {relative}"))?;
                }
                if let Some(destination) = move_to {
                    let (moved, moved_relative) =
                        resolve_workspace_path(&session.config.cwd, &destination)?;
                    if moved != target
                        && (moved.exists() || transaction.planned_content(&moved).is_some())
                    {
                        return Err(format!("Patch target already exists: {moved_relative}"));
                    }
                    transaction.set_change(target, None);
                    transaction.set_change(moved, Some(content));
                    transaction
                        .summaries
                        .push(format!("renamed {relative} -> {moved_relative}"));
                } else {
                    transaction.set_change(target, Some(content));
                    transaction.summaries.push(format!("modified {relative}"));
                }
            }
        }
    }
    Ok(transaction)
}

pub(super) fn commit_patch(root: &Path, transaction: PatchTransaction) -> Result<(), String> {
    commit_patch_with_hook(root, transaction, |_| Ok(()))
}

fn commit_patch_with_hook<F>(
    root: &Path,
    transaction: PatchTransaction,
    mut before_step: F,
) -> Result<(), String>
where
    F: FnMut(PatchCommitStep) -> Result<(), String>,
{
    let (changes, directories) = validate_transaction(root, transaction.changes)?;
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
            return Err(format!("Patch staging failed: {error}"));
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
            return Err(format!("Patch staging failed: {error}"));
        }
    }

    for index in 0..changes.len() {
        let result = apply_change(root, index, &mut records[index], &mut before_step);
        if let Err(error) = result {
            let rollback_errors = rollback(&mut records, &created_directories);
            return if rollback_errors.is_empty() {
                Err(format!(
                    "Patch commit failed and all changes were rolled back: {error}"
                ))
            } else {
                Err(format!(
                    "Patch commit failed: {error}. Rollback also failed: {}",
                    rollback_errors.join("; ")
                ))
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
            let result = commit_patch_with_hook(directory.path(), transaction, |step| {
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
        let result = commit_patch_with_hook(directory.path(), transaction, |step| {
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
        let result = commit_patch_with_hook(directory.path(), transaction, |step| {
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
