//! Warm workspace `search`.
//!
//! `find` and `grep` walk the tree from scratch on every call. `search` walks it
//! once per run and answers later queries in that run from memory. The index
//! holds paths only: file contents are read live at query time, so editing a file
//! can never serve a stale line.
//!
//! Freshness is a single monotonic generation counter. A rebuild captures the
//! generation it started at and publishes only if that generation is still
//! current, so a mutation landing mid-build can never be overwritten by the
//! older walk. Mutations that change path membership patch the entry list in
//! place and bump the generation with it, which keeps the index warm while still
//! invalidating any build already in flight.

use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde_json::json;

use super::*;

/// Refuse to publish a partial index rather than silently answer from one.
const MAX_INDEX_ENTRIES: usize = 500_000;
/// Content scanning skips anything larger; `read` and `grep` remain available.
const MAX_CONTENT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_LINE_BYTES: usize = 8 * 1024;
/// Matches the cadence the LSP client already uses to observe run abort.
const ABORT_POLL: Duration = Duration::from_millis(25);
const DEFAULT_PATH_LIMIT: u64 = 100;
const DEFAULT_CONTENT_LIMIT: u64 = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct IndexEntry {
    pub(super) relative: String,
    pub(super) is_dir: bool,
}

#[derive(Debug, Default)]
struct IndexState {
    /// The generation the current `entries` were valid at. `None` until a first
    /// successful build.
    built_generation: Option<u64>,
    entries: Arc<Vec<IndexEntry>>,
}

/// The session-lived path index. Shared by `Arc`; synchronizes internally.
#[derive(Debug)]
pub struct SearchIndex {
    generation: AtomicU64,
    state: Mutex<IndexState>,
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(1),
            state: Mutex::new(IndexState::default()),
        }
    }
}

impl SearchIndex {
    fn lock(&self) -> std::sync::MutexGuard<'_, IndexState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Invalidates the whole index. The next `search` rebuilds; nothing else does
    /// work, so a run that never searches never pays for the walk.
    pub fn mark_stale(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Indexed entry count and the heap bytes those entries hold.
    ///
    /// Reported by the performance gate instead of process RSS: RSS needs
    /// platform-specific probes and moves with allocator behavior, while this is
    /// portable, deterministic, and measures the thing the index actually costs.
    #[cfg(test)]
    pub(super) fn footprint(&self) -> (usize, usize) {
        let state = self.lock();
        let bytes = state
            .entries
            .iter()
            .map(|entry| entry.relative.capacity() + std::mem::size_of::<IndexEntry>())
            .sum();
        (state.entries.len(), bytes)
    }

    /// The entry list if it is current for `generation`.
    fn cached(&self, generation: u64) -> Option<Arc<Vec<IndexEntry>>> {
        let state = self.lock();
        (state.built_generation == Some(generation)).then(|| Arc::clone(&state.entries))
    }

    /// Publishes a completed build, but only if nothing invalidated the index
    /// while the walk was running.
    fn publish(&self, generation: u64, entries: Vec<IndexEntry>) -> bool {
        let mut state = self.lock();
        if self.generation() != generation {
            return false;
        }
        state.built_generation = Some(generation);
        state.entries = Arc::new(entries);
        true
    }

    /// Applies a membership change without discarding the warm index. Bumping the
    /// generation alongside the edit is what makes an in-flight build unable to
    /// publish over it.
    fn patch(&self, mutate: impl FnOnce(&mut Vec<IndexEntry>)) {
        let mut state = self.lock();
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if state.built_generation.is_none() {
            // Nothing warm to patch; the bump above already forces a rebuild.
            return;
        }
        let entries = Arc::make_mut(&mut state.entries);
        mutate(entries);
        state.built_generation = Some(next);
    }

    /// Records a created file and any parent directories created with it.
    pub(super) fn note_created(&self, relative: &str) {
        let relative = relative.trim_matches('/').to_owned();
        if relative.is_empty() {
            return;
        }
        self.patch(|entries| {
            let mut ancestors = Vec::new();
            let mut prefix = String::new();
            let segments = relative.split('/').collect::<Vec<_>>();
            for segment in &segments[..segments.len().saturating_sub(1)] {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                ancestors.push(IndexEntry {
                    relative: prefix.clone(),
                    is_dir: true,
                });
            }
            ancestors.push(IndexEntry {
                relative: relative.clone(),
                is_dir: false,
            });
            for entry in ancestors {
                if let Err(position) =
                    entries.binary_search_by(|probe| probe.relative.cmp(&entry.relative))
                {
                    entries.insert(position, entry);
                }
            }
        });
    }

    /// Records a deleted file. Parent directories are left in place: an emptied
    /// directory still exists on disk.
    pub(super) fn note_removed(&self, relative: &str) {
        let relative = relative.trim_matches('/').to_owned();
        if relative.is_empty() {
            return;
        }
        self.patch(|entries| {
            if let Ok(position) = entries.binary_search_by(|probe| probe.relative.cmp(&relative)) {
                entries.remove(position);
            }
        });
    }
}

/// Applies a completed mutation to the index. `apply_patch` renames report only
/// the destination path, so a rename invalidates coarsely rather than leaving the
/// vanished source path indexed.
pub(super) fn note_mutation(index: &SearchIndex, tool: &str, details: Option<&Value>) {
    let Some(details) = details else {
        index.mark_stale();
        return;
    };
    match tool {
        "write" => {
            if details.get("effect").and_then(Value::as_str) == Some("created")
                && let Some(path) = details.get("path").and_then(Value::as_str)
            {
                index.note_created(path);
            }
        }
        // An edit replaces bytes in a file that is already indexed.
        "edit" => {}
        "apply_patch" => {
            for effect in details
                .get("effects")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let Some(path) = effect.get("path").and_then(Value::as_str) else {
                    continue;
                };
                match effect.get("action").and_then(Value::as_str) {
                    Some("added") => index.note_created(path),
                    Some("deleted") => index.note_removed(path),
                    Some("modified") => {}
                    // The source path of a rename is not reported, so it cannot
                    // be removed precisely.
                    _ => index.mark_stale(),
                }
            }
        }
        _ => index.mark_stale(),
    }
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn index_too_large() -> ToolError {
    ToolError {
        status: "validation_error",
        code: "search_index_too_large",
        message: format!(
            "This workspace has more than {MAX_INDEX_ENTRIES} visible paths, which is too many to index. Use find or grep with a narrower path."
        ),
        details: Some(json!({ "maxEntries": MAX_INDEX_ENTRIES })),
    }
}

fn build_entries(root: &Path, session: &Session) -> Result<Vec<IndexEntry>, ToolError> {
    let mut entries = Vec::new();
    let mut last_poll = Instant::now();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        // Pruning at the directory keeps a blocked or generated tree from being
        // walked and discarded entry by entry.
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_symlink() {
                return false;
            }
            relative_path(root, entry.path()).is_some_and(|relative| !should_skip(&relative))
        });
    for entry in walker {
        if last_poll.elapsed() >= ABORT_POLL {
            last_poll = Instant::now();
            if session.is_aborted() {
                return Err(ToolError::aborted("Search was aborted."));
            }
        }
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Some(relative) = relative_path(root, entry.path()) else {
            continue;
        };
        if entries.len() >= MAX_INDEX_ENTRIES {
            return Err(index_too_large());
        }
        entries.push(IndexEntry {
            relative,
            is_dir: entry.file_type().is_dir(),
        });
    }
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(entries)
}

/// Returns the warm entry list, rebuilding it if this run has not searched yet.
fn entries_for(session: &Session, root: &Path) -> Result<Arc<Vec<IndexEntry>>, ToolError> {
    // Bounded: a retry only happens when a mutation lands during the walk, and
    // `search` is a global execution barrier, so this is not a hot path.
    for _ in 0..3 {
        let generation = session.search_index.generation();
        if let Some(entries) = session.search_index.cached(generation) {
            return Ok(entries);
        }
        let built = build_entries(root, session)?;
        if session.search_index.publish(generation, built)
            && let Some(entries) = session.search_index.cached(generation)
        {
            return Ok(entries);
        }
    }
    // The index kept moving under us; answer from a fresh walk without caching.
    Ok(Arc::new(build_entries(root, session)?))
}

fn glob_matcher(glob: &str) -> Result<Option<GlobSet>, ToolError> {
    if glob.is_empty() {
        return Ok(None);
    }
    GlobBuilder::new(glob)
        .case_insensitive(false)
        .literal_separator(true)
        .build()
        .and_then(|value| {
            let mut set = GlobSetBuilder::new();
            set.add(value);
            set.build()
        })
        .map(Some)
        .map_err(|_| ToolError::validation("search glob is invalid"))
}

fn glob_admits(matcher: Option<&GlobSet>, relative: &str) -> bool {
    let Some(matcher) = matcher else {
        return true;
    };
    let basename = relative.rsplit('/').next().unwrap_or(relative);
    matcher.is_match(relative) || matcher.is_match(basename)
}

/// Smart case: an uppercase character anywhere in the query means the user meant
/// it, so the comparison becomes case-sensitive.
fn is_case_sensitive(query: &str) -> bool {
    query.chars().any(char::is_uppercase)
}

fn fold(value: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        value.to_owned()
    } else {
        value.to_ascii_lowercase()
    }
}

/// Lower is better. `None` omits the path: v1 has no edit-distance matcher, so a
/// path that matches no rule is not a result.
fn path_score(relative: &str, query: &str, tokens: &[String], case_sensitive: bool) -> Option<u8> {
    let hay = fold(relative, case_sensitive);
    let basename = hay.rsplit('/').next().unwrap_or(&hay).to_owned();
    if basename == query {
        return Some(0);
    }
    if basename.starts_with(query) {
        return Some(1);
    }
    if basename.contains(query) {
        return Some(2);
    }
    if hay.contains(query) {
        return Some(3);
    }
    if tokens.len() > 1 && tokens.iter().all(|token| hay.contains(token.as_str())) {
        return Some(4);
    }
    None
}

/// Whether an indexed path is inside the requested scope.
fn scope_admits(relative: &str, scope: &str) -> bool {
    if scope.is_empty() {
        return true;
    }
    relative == scope
        || (relative.len() > scope.len()
            && relative.as_bytes()[scope.len()] == b'/'
            && relative.starts_with(scope))
}

struct SearchScope {
    root: PathBuf,
    /// Workspace-relative scope prefix; empty means the workspace root.
    relative: String,
    matcher: Option<GlobSet>,
}

fn search_path_mode(
    entries: &[IndexEntry],
    scope: &SearchScope,
    query: &str,
    limit: usize,
) -> (Vec<String>, bool) {
    let case_sensitive = is_case_sensitive(query);
    let folded_query = fold(query, case_sensitive);
    let tokens = folded_query
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut scored = Vec::new();
    for entry in entries {
        if !scope_admits(&entry.relative, &scope.relative) {
            continue;
        }
        if !glob_admits(scope.matcher.as_ref(), &entry.relative) {
            continue;
        }
        if let Some(score) = path_score(&entry.relative, &folded_query, &tokens, case_sensitive) {
            scored.push((score, entry.relative.clone()));
        }
    }
    // Ties break on relative-path lexical order, so results are stable.
    scored.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let truncated = scored.len() > limit;
    scored.truncate(limit);
    (
        scored.into_iter().map(|(_, relative)| relative).collect(),
        truncated,
    )
}

struct ContentOutcome {
    rows: Vec<String>,
    /// Matching lines, which `limit` bounds. `rows` also carries context lines.
    matches: usize,
    truncated: bool,
    files_scanned: usize,
    files_skipped: usize,
}

/// One output row. `:` marks the matching line and `-` a context line, matching
/// what `grep` emits, so the two tools read the same way.
fn content_row(path: &str, number: usize, marker: char, line: &str) -> String {
    format!("{path}:{number}{marker} {}", clip_line(line))
}

fn search_content_mode(
    session: &Session,
    entries: &[IndexEntry],
    scope: &SearchScope,
    query: &str,
    context: usize,
    limit: usize,
) -> Result<ContentOutcome, ToolError> {
    let case_sensitive = is_case_sensitive(query);
    let needle = fold(query, case_sensitive);
    let mut rows: Vec<String> = Vec::new();
    let mut matches = 0usize;
    let mut truncated = false;
    let mut files_scanned = 0usize;
    let mut files_skipped = 0usize;
    let mut last_poll = Instant::now();
    for entry in entries {
        if last_poll.elapsed() >= ABORT_POLL {
            last_poll = Instant::now();
            if session.is_aborted() {
                return Err(ToolError::aborted("Search was aborted."));
            }
        }
        if entry.is_dir
            || !scope_admits(&entry.relative, &scope.relative)
            || !glob_admits(scope.matcher.as_ref(), &entry.relative)
        {
            continue;
        }
        let absolute = scope.root.join(&entry.relative);
        // The index holds paths; the file itself is re-checked live, so an
        // out-of-process delete or swap cannot be served from memory.
        let Ok(metadata) = fs::symlink_metadata(&absolute) else {
            files_skipped += 1;
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_CONTENT_FILE_BYTES {
            files_skipped += 1;
            continue;
        }
        let Ok(handle) = fs::File::open(&absolute) else {
            files_skipped += 1;
            continue;
        };
        files_scanned += 1;
        let reader = BufReader::new(handle);
        let mut binary = false;
        // Rows are held per file so that a file revealed as binary partway
        // through contributes nothing, exactly as it did before context existed.
        let mut file_rows: Vec<String> = Vec::new();
        let mut file_matches = 0usize;
        // The trailing `context` lines, kept as a ring rather than buffering the
        // whole file, so a `context: 0` search costs what it always has.
        let mut preceding: VecDeque<(usize, String)> = VecDeque::with_capacity(context);
        let mut following = 0usize;
        // Guards against emitting a line twice when two matches sit close enough
        // for their context windows to overlap.
        let mut last_emitted = 0usize;
        for (index, line) in reader.lines().enumerate() {
            let Ok(line) = line else {
                binary = true;
                break;
            };
            if line.as_bytes().contains(&0) {
                binary = true;
                break;
            }
            let number = index + 1;
            if fold(&line, case_sensitive).contains(&needle) {
                if matches + file_matches >= limit {
                    truncated = true;
                    break;
                }
                for (preceding_number, text) in preceding.drain(..) {
                    if preceding_number > last_emitted {
                        file_rows.push(content_row(&entry.relative, preceding_number, '-', &text));
                        last_emitted = preceding_number;
                    }
                }
                file_rows.push(content_row(&entry.relative, number, ':', &line));
                last_emitted = number;
                file_matches += 1;
                following = context;
                continue;
            }
            if following > 0 {
                file_rows.push(content_row(&entry.relative, number, '-', &line));
                last_emitted = number;
                following -= 1;
            }
            if context > 0 {
                if preceding.len() == context {
                    preceding.pop_front();
                }
                preceding.push_back((number, line));
            }
        }
        if binary {
            files_scanned -= 1;
            files_skipped += 1;
            continue;
        }
        rows.append(&mut file_rows);
        matches += file_matches;
        if truncated {
            break;
        }
    }
    Ok(ContentOutcome {
        rows,
        matches,
        truncated,
        files_scanned,
        files_skipped,
    })
}

fn clip_line(value: &str) -> String {
    if value.len() <= MAX_SEARCH_LINE_BYTES {
        return value.to_owned();
    }
    let mut end = MAX_SEARCH_LINE_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

pub(super) async fn search_tool(
    session: Arc<Session>,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let query = string_arg(input, &["query"]);
    let mode = string_arg(input, &["mode"]);
    let path = string_arg(input, &["path"]);
    if query.is_empty() || path.is_empty() {
        return Err("search requires string arguments query, mode, and path".into());
    }
    if mode != "path" && mode != "content" {
        return Err("search mode must be path or content".into());
    }
    let glob = string_arg(input, &["glob"]);
    let context = number_arg(input, "context", 0) as usize;
    let limit = number_arg(
        input,
        "limit",
        if mode == "path" {
            DEFAULT_PATH_LIMIT
        } else {
            DEFAULT_CONTENT_LIMIT
        },
    ) as usize;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::validation(format!("Path not found: {relative}")));
        }
        Err(error) => return Err(ToolError::runtime(error.to_string())),
    };
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(ToolError::validation(
            "search path must be a file or directory",
        ));
    }
    let scope = SearchScope {
        root: session
            .config
            .cwd
            .canonicalize()
            .unwrap_or_else(|_| session.config.cwd.clone()),
        relative: relative.clone(),
        matcher: glob_matcher(&glob)?,
    };
    let mode_owned = mode.clone();
    let query_owned = query.clone();
    // Walking and scanning are blocking filesystem work; keep them off the async
    // executor and never hold the index lock across them.
    let outcome = tokio::task::spawn_blocking(move || {
        let entries = entries_for(&session, &scope.root)?;
        if mode_owned == "path" {
            let (paths, truncated) = search_path_mode(&entries, &scope, &query_owned, limit);
            let count = paths.len();
            Ok::<_, ToolError>((paths, count, truncated, None))
        } else {
            let content =
                search_content_mode(&session, &entries, &scope, &query_owned, context, limit)?;
            Ok((
                content.rows,
                content.matches,
                content.truncated,
                Some((content.files_scanned, content.files_skipped)),
            ))
        }
    })
    .await
    .map_err(|_| ToolError::runtime("Search did not complete."))?;
    let (rows, result_count, truncated, counts) = outcome?;
    let scope_label = if relative.is_empty() {
        ".".to_owned()
    } else {
        relative.clone()
    };
    let content = if rows.is_empty() {
        if mode == "path" {
            "No matching paths.".to_owned()
        } else {
            "No matches.".to_owned()
        }
    } else {
        rows.join("\n")
    };
    // resultCount counts paths in path mode and matching lines in content mode,
    // which is what `limit` bounds. Context lines ride along in `rows` without
    // inflating the number the model reasons about.
    let mut details = json!({
        "mode": mode,
        "path": scope_label,
        "query": query,
        "resultCount": result_count,
        "truncated": truncated,
    });
    if let Some((scanned, skipped)) = counts {
        let fields = details.as_object_mut().expect("details is an object");
        fields.insert("filesScanned".into(), json!(scanned));
        fields.insert("filesSkipped".into(), json!(skipped));
    }
    Ok(ToolResult::success_detailed(
        format!("search {query}"),
        content,
        Some(details),
        None,
    ))
}
