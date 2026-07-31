use std::{collections::HashSet, thread};

use super::*;

#[derive(Default)]
pub(super) struct SearchQuery {
    pub(super) terms: Vec<String>,
    pub(super) include_dirs: Vec<String>,
    pub(super) include_globs: Vec<String>,
    pub(super) exclude_dirs: Vec<String>,
    pub(super) exclude_globs: Vec<String>,
    pub(super) location: Option<String>,
    pub(super) smart_case: bool,
}

pub(super) fn parse_search_query(raw: &str) -> SearchQuery {
    let mut query = SearchQuery {
        smart_case: raw.chars().any(char::is_uppercase),
        ..Default::default()
    };
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    for value in raw.chars() {
        if quote.is_some_and(|active| active == value) {
            quote = None;
        } else if quote.is_none() && token.is_empty() && matches!(value, '\'' | '"') {
            quote = Some(value);
        } else if quote.is_none() && value.is_whitespace() {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
        } else {
            token.push(value);
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    for token in tokens {
        let excluded = token.starts_with('!') && token.len() > 1;
        let value = token
            .trim_start_matches('!')
            .trim_start_matches("./")
            .replace('\\', "/");
        if !excluded
            && let Some((path, suffix)) = value.rsplit_once(':')
            && suffix.parse::<u64>().is_ok()
            && !path.is_empty()
        {
            query.location = path
                .rsplit_once(':')
                .filter(|(_, line)| line.parse::<u64>().is_ok())
                .map_or_else(|| Some(path.to_owned()), |(path, _)| Some(path.to_owned()));
            continue;
        }
        if value.ends_with('/') {
            if excluded {
                query.exclude_dirs.push(value);
            } else {
                query.include_dirs.push(value);
            }
        } else if value
            .chars()
            .any(|value| matches!(value, '*' | '?' | '[' | ']'))
        {
            if excluded {
                query.exclude_globs.push(value);
            } else {
                query.include_globs.push(value);
            }
        } else if excluded {
            query.exclude_globs.push(value);
        } else if !value.is_empty() {
            query.terms.push(value);
        }
    }
    query
}

fn glob_matches(pattern: &str, relative: &str, filename: &str, case_sensitive: bool) -> bool {
    let target = if pattern.contains('/') {
        relative
    } else {
        filename
    };
    GlobBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .literal_separator(true)
        .build()
        .is_ok_and(|glob| glob.compile_matcher().is_match(target))
}

fn search_constraints(relative: &str, filename: &str, query: &SearchQuery) -> bool {
    let candidate = if query.smart_case {
        relative.to_owned()
    } else {
        relative.to_lowercase()
    };
    let normalize = |value: &str| {
        if query.smart_case {
            value.to_owned()
        } else {
            value.to_lowercase()
        }
    };
    (query.include_dirs.is_empty()
        || query
            .include_dirs
            .iter()
            .any(|value| candidate.starts_with(&normalize(value))))
        && (query.include_globs.is_empty()
            || query
                .include_globs
                .iter()
                .any(|value| glob_matches(value, relative, filename, query.smart_case)))
        && !query.exclude_dirs.iter().any(|value| {
            let value = normalize(value);
            candidate.starts_with(&value) || candidate.contains(&format!("/{value}"))
        })
        && !query
            .exclude_globs
            .iter()
            .any(|value| glob_matches(value, relative, filename, query.smart_case))
}

fn fuzzy_score(candidate: &str, query: &str, filename: bool) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let chars = candidate.chars().collect::<Vec<_>>();
    let mut last = None;
    let mut first = 0usize;
    let mut run = 0usize;
    let mut score = if filename { 120.0 } else { 70.0 };
    for query_char in query.chars() {
        let start = last.map_or(0, |value| value + 1);
        let Some(next) = chars
            .iter()
            .enumerate()
            .skip(start)
            .find_map(|(index, value)| (*value == query_char).then_some(index))
        else {
            return 0.0;
        };
        if last.is_none() {
            first = next;
        }
        if last.is_some_and(|value| next == value + 1) {
            run += 1;
            score += 12.0 + run.min(5) as f64 * 3.0;
        } else {
            run = 1;
            score += 5.0;
        }
        if next == 0
            || chars
                .get(next.saturating_sub(1))
                .is_some_and(|value| "/._-".contains(*value))
        {
            score += if filename { 12.0 } else { 6.0 };
        }
        last = Some(next);
    }
    let last = last.unwrap_or(first);
    let query_len = query.chars().count();
    let span = last - first + 1;
    score += query_len as f64 * if filename { 10.0 } else { 6.0 };
    score -= span.saturating_sub(query_len) as f64 * 2.0;
    score -= first as f64 * 0.5;
    score.max(1.0)
}

pub(super) fn term_score(relative: &str, filename: &str, term: &str, case_sensitive: bool) -> f64 {
    let convert = |value: &str| {
        if case_sensitive {
            value.to_owned()
        } else {
            value.to_lowercase()
        }
    };
    let query = convert(term);
    let name = convert(filename);
    let path = convert(relative);
    let mut score: f64 = 0.0;
    if name == query {
        score = score.max(600.0);
    }
    if path == query {
        score = score.max(580.0);
    }
    if path.ends_with(&query) {
        score = score.max(360.0);
    }
    if let Some(index) = name.find(&query) {
        score = score.max(320.0 - index.min(80) as f64);
    }
    if let Some(index) = path.find(&query) {
        score = score.max(180.0 - index.min(80) as f64);
    }
    score
        .max(fuzzy_score(&name, &query, true))
        .max(fuzzy_score(&path, &query, false))
}

#[derive(Default)]
struct SearchStats {
    scanned_files: usize,
    scanned_bytes: u64,
    skipped_files: usize,
}

struct SearchCandidate {
    path: PathBuf,
    relative: String,
    size: u64,
    boost: f64,
}

type ContentHit = (String, usize, u8, usize, f64, String, String);

fn scan_candidates(
    candidates: &[SearchCandidate],
    normalized_terms: &[String],
    display_terms: &[String],
    smart_case: bool,
    broad_scan: bool,
    definition_pattern: &Regex,
    import_pattern: &Regex,
) -> (Vec<ContentHit>, SearchStats) {
    let mut hits = Vec::new();
    let mut stats = SearchStats::default();
    for candidate in candidates {
        let Ok(bytes) = fs::read(&candidate.path) else {
            stats.skipped_files += 1;
            continue;
        };
        if bytes.contains(&0) {
            stats.skipped_files += 1;
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            stats.skipped_files += 1;
            continue;
        };
        stats.scanned_files += 1;
        stats.scanned_bytes = stats.scanned_bytes.saturating_add(candidate.size);
        let normalized_content = if smart_case {
            content.clone()
        } else {
            content.to_lowercase()
        };
        let file_matches = if broad_scan {
            normalized_terms
                .iter()
                .any(|term| normalized_content.contains(term))
        } else {
            normalized_terms
                .iter()
                .all(|term| normalized_content.contains(term))
        };
        if !file_matches {
            continue;
        }
        for (index, line) in content.lines().enumerate() {
            let normalized_line = if smart_case {
                line.to_owned()
            } else {
                line.to_lowercase()
            };
            let matched_indexes = normalized_terms
                .iter()
                .enumerate()
                .filter_map(|(term_index, term)| {
                    normalized_line.contains(term).then_some(term_index)
                })
                .collect::<Vec<_>>();
            if matched_indexes.is_empty() {
                continue;
            }
            let trimmed = line.trim_start();
            let rank = if definition_pattern.is_match(trimmed) {
                0
            } else if import_pattern.is_match(trimmed) {
                2
            } else {
                1
            };
            let labels = if broad_scan {
                matched_indexes
                    .iter()
                    .map(|term_index| display_terms[*term_index].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                String::new()
            };
            hits.push((
                candidate.relative.clone(),
                index + 1,
                rank,
                matched_indexes.len(),
                candidate.boost,
                line.chars().take(240).collect(),
                labels,
            ));
        }
    }
    (hits, stats)
}

fn run_search(
    cwd: PathBuf,
    parsed: SearchQuery,
    broad_terms: Vec<String>,
    limit: usize,
    recent: HashMap<PathBuf, u64>,
    title: String,
) -> ToolResult {
    let broad_scan = !broad_terms.is_empty();
    let display_terms = if broad_scan {
        broad_terms
    } else {
        parsed.terms.clone()
    };
    let normalized_terms = display_terms
        .iter()
        .map(|term| {
            if parsed.smart_case {
                term.clone()
            } else {
                term.to_lowercase()
            }
        })
        .collect::<Vec<_>>();
    let path_terms = if parsed.terms.is_empty() {
        parsed.location.iter().cloned().collect::<Vec<_>>()
    } else {
        parsed.terms.clone()
    };
    let mut path_hits: Vec<(String, f64)> = Vec::new();
    let mut candidates = Vec::new();
    let mut stats = SearchStats::default();
    let definition_pattern = Regex::new(
        r"^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|fn|def|impl|trait)\b",
    )
    .expect("definition ranking regex is valid");
    let import_pattern = Regex::new(r"^(?:import\b|from\b|require\s*\(|use\b|#include\b)")
        .expect("import ranking regex is valid");
    for entry in WalkDir::new(&cwd)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let relative = entry
                .path()
                .strip_prefix(&cwd)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            let candidate = if entry.file_type().is_dir() {
                format!("{relative}/")
            } else {
                relative.clone()
            };
            relative.is_empty() || !should_skip(&candidate)
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&cwd)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let filename = entry.file_name().to_string_lossy();
        if !search_constraints(&relative, &filename, &parsed) {
            continue;
        }
        let has_path_intent = !path_terms.is_empty()
            || !parsed.include_dirs.is_empty()
            || !parsed.include_globs.is_empty()
            || parsed.location.is_some();
        let base = if path_terms.is_empty() {
            10.0
        } else {
            path_terms
                .iter()
                .try_fold(0.0, |total, term| {
                    let score = term_score(&relative, &filename, term, parsed.smart_case);
                    (score > 0.0).then_some(total + score)
                })
                .unwrap_or(0.0)
        };
        let boost = recent.get(entry.path()).copied().unwrap_or(0) as f64 * 35.0;
        if !broad_scan && has_path_intent && base > 0.0 {
            path_hits.push((relative.clone(), base + boost));
        }
        if normalized_terms.is_empty() {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) if metadata.len() <= MAX_TEXT_FILE_BYTES => {
                candidates.push(SearchCandidate {
                    path: entry.path().to_owned(),
                    relative,
                    size: metadata.len(),
                    boost,
                });
            }
            _ => stats.skipped_files += 1,
        }
    }
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(8)
        .min(candidates.len().max(1));
    let chunk_size = candidates.len().div_ceil(worker_count);
    let mut content_hits = Vec::new();
    if chunk_size > 0 {
        thread::scope(|scope| {
            let handles = candidates
                .chunks(chunk_size)
                .map(|chunk| {
                    scope.spawn(|| {
                        scan_candidates(
                            chunk,
                            &normalized_terms,
                            &display_terms,
                            parsed.smart_case,
                            broad_scan,
                            &definition_pattern,
                            &import_pattern,
                        )
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                let (mut hits, batch_stats) = handle.join().expect("search worker must not panic");
                content_hits.append(&mut hits);
                stats.scanned_files += batch_stats.scanned_files;
                stats.scanned_bytes = stats
                    .scanned_bytes
                    .saturating_add(batch_stats.scanned_bytes);
                stats.skipped_files += batch_stats.skipped_files;
            }
        });
    }
    path_hits.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then(left.0.len().cmp(&right.0.len()))
            .then(left.0.cmp(&right.0))
    });
    content_hits.sort_by(|left, right| {
        right
            .3
            .cmp(&left.3)
            .then(left.2.cmp(&right.2))
            .then(right.4.total_cmp(&left.4))
            .then(left.0.cmp(&right.0))
            .then(left.1.cmp(&right.1))
    });
    let matched_files = content_hits
        .iter()
        .map(|hit| hit.0.as_str())
        .collect::<HashSet<_>>()
        .len();
    let mut results = path_hits
        .into_iter()
        .map(|(path, _)| format!("{path}: path"))
        .collect::<Vec<_>>();
    results.extend(
        content_hits
            .into_iter()
            .map(|(path, line, _, _, _, snippet, labels)| {
                if labels.is_empty() {
                    format!("{path}:{line}: {snippet}")
                } else {
                    format!("{path}:{line}: [{labels}] {snippet}")
                }
            }),
    );
    results.truncate(limit);
    let coverage = if normalized_terms.is_empty() {
        "Search coverage: path index only; file contents were not read.".to_owned()
    } else {
        format!(
            "Search coverage: scanned {} text files ({} bytes), matched {matched_files} files, and skipped {} oversized, binary, unreadable, or non-UTF-8 files.",
            stats.scanned_files, stats.scanned_bytes, stats.skipped_files
        )
    };
    let output = if results.is_empty() {
        format!(
            "{coverage}\nNo matches for the search terms. Try fewer terms or a broader path. Use only exact result paths; list a directory with read before choosing a file."
        )
    } else {
        format!("{coverage}\n{}", results.join("\n"))
    };
    ToolResult::success(format!("search {title}"), output)
}

pub(super) async fn search_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let query = string_arg(input, &["query"]);
    let broad_terms = match input.get("queries") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| value.as_str().unwrap_or("").trim().to_owned())
            .collect::<Vec<_>>(),
        Some(_) => return Err("search argument queries must be an array of strings".into()),
    };
    if !query.trim().is_empty() && !broad_terms.is_empty() {
        return Err("search accepts query or queries, not both".into());
    }
    if broad_terms.len() > 32
        || broad_terms
            .iter()
            .any(|term| term.is_empty() || term.chars().count() > 256 || term.contains('\0'))
    {
        return Err(
            "search queries must contain 1 to 32 non-empty terms of at most 256 characters".into(),
        );
    }
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, 200) as usize;
    let mut parsed = parse_search_query(&query);
    if let Some(case_sensitive) = input.get("caseSensitive").and_then(Value::as_bool) {
        parsed.smart_case = case_sensitive;
    } else if broad_terms
        .iter()
        .any(|term| term.chars().any(char::is_uppercase))
    {
        parsed.smart_case = true;
    }
    for scope in string_list_arg(input, &["path"])
        .into_iter()
        .filter(|value| !value.trim().is_empty())
    {
        let (absolute, relative) =
            resolve_workspace_path(&session.config.cwd, scope.trim()).map_err(ToolError::policy)?;
        let relative = relative.replace('\\', "/");
        if absolute.is_file() {
            parsed.include_globs.push(relative);
        } else if !relative.is_empty() {
            parsed
                .include_dirs
                .push(format!("{}/", relative.trim_end_matches('/')));
        }
    }
    parsed.include_globs.extend(
        string_list_arg(input, &["glob"])
            .into_iter()
            .map(|value| value.trim().trim_start_matches("./").replace('\\', "/"))
            .filter(|value| !value.is_empty()),
    );
    for value in string_list_arg(input, &["exclude"])
        .into_iter()
        .map(|value| value.trim().trim_start_matches('!').replace('\\', "/"))
        .filter(|value| !value.is_empty())
    {
        if value.ends_with('/') {
            parsed.exclude_dirs.push(value);
        } else {
            parsed.exclude_globs.push(value);
        }
    }
    if parsed.terms.is_empty()
        && broad_terms.is_empty()
        && parsed.include_dirs.is_empty()
        && parsed.include_globs.is_empty()
        && parsed.location.is_none()
    {
        return Err("search requires query, queries, path, or glob".into());
    }
    let recent = RECENT_READS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .clone();
    let title = if broad_terms.is_empty() {
        if query.trim().is_empty() {
            string_arg(input, &["path"])
        } else {
            query
        }
    } else {
        format!("{} broad terms", broad_terms.len())
    };
    let cwd = session.config.cwd.clone();
    tokio::task::spawn_blocking(move || run_search(cwd, parsed, broad_terms, limit, recent, title))
        .await
        .map_err(|_| ToolError::runtime("Workspace search worker failed."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn broad_search_scans_independent_terms_in_one_bounded_pass() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("src")).unwrap();
        std::fs::write(
            directory.path().join("src/server.ts"),
            "export function execute(value: string) {\n  return eval(value);\n}\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("src/native.rs"),
            "fn decode() {\n    unsafe { run(); }\n}\n",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("src/large.txt"),
            "password ".repeat(70_000),
        )
        .unwrap();
        let session = crate::session::test_session(directory.path());

        let result = search_tool(
            &session,
            json!({
                "queries":["eval(", "unsafe", "password"],
                "path":"src",
                "limit":20
            })
            .as_object()
            .unwrap(),
        )
        .await
        .unwrap();

        assert!(
            result
                .output
                .contains("Search coverage: scanned 2 text files")
        );
        assert!(result.output.contains("matched 2 files"));
        assert!(result.output.contains("skipped 1"));
        assert!(result.output.contains("src/server.ts:2: [eval(]"));
        assert!(result.output.contains("src/native.rs:2: [unsafe]"));
        assert!(!result.output.contains("large.txt:"));
    }

    #[tokio::test]
    async fn path_only_search_does_not_read_file_contents() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("src")).unwrap();
        std::fs::write(
            directory.path().join("src/large.txt"),
            "content ".repeat(70_000),
        )
        .unwrap();
        let session = crate::session::test_session(directory.path());

        let result = search_tool(
            &session,
            json!({"path":"src","limit":20}).as_object().unwrap(),
        )
        .await
        .unwrap();

        assert!(
            result
                .output
                .contains("Search coverage: path index only; file contents were not read.")
        );
        assert!(result.output.contains("src/large.txt: path"));
    }
}
