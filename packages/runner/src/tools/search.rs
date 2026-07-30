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

pub(super) async fn search_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let query = string_arg(input, &["query", "pattern", "term", "text"]);
    let limit = input
        .get("limit")
        .or_else(|| input.get("maxResults"))
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, 100) as usize;
    let mut parsed = parse_search_query(&query);
    if let Some(case_sensitive) = input.get("caseSensitive").and_then(Value::as_bool) {
        parsed.smart_case = case_sensitive;
    }
    for scope in string_list_arg(input, &["path", "directory", "filePath"])
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
        string_list_arg(input, &["glob", "filePattern"])
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
        && parsed.include_dirs.is_empty()
        && parsed.include_globs.is_empty()
        && parsed.location.is_none()
    {
        return Err("search requires query, path, or glob".into());
    }
    let path_terms = if parsed.terms.is_empty() {
        parsed.location.iter().cloned().collect::<Vec<_>>()
    } else {
        parsed.terms.clone()
    };
    let recent = RECENT_READS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .clone();
    let mut path_hits: Vec<(String, f64)> = Vec::new();
    let mut content_hits: Vec<(String, usize, u8, usize, f64, String)> = Vec::new();
    let definition_pattern = Regex::new(
        r"^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|fn|def|impl|trait)\b",
    )
    .expect("definition ranking regex is valid");
    let import_pattern = Regex::new(r"^(?:import\b|from\b|require\s*\(|use\b|#include\b)")
        .expect("import ranking regex is valid");
    let normalized_terms = parsed
        .terms
        .iter()
        .map(|term| {
            if parsed.smart_case {
                term.clone()
            } else {
                term.to_lowercase()
            }
        })
        .collect::<Vec<_>>();
    for entry in WalkDir::new(&session.config.cwd)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let relative = entry
                .path()
                .strip_prefix(&session.config.cwd)
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
            .strip_prefix(&session.config.cwd)
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
        let canonical = entry
            .path()
            .canonicalize()
            .unwrap_or_else(|_| entry.path().to_owned());
        let boost = recent.get(&canonical).copied().unwrap_or(0) as f64 * 35.0;
        if has_path_intent && base > 0.0 {
            path_hits.push((relative.clone(), base + boost));
        }
        if entry
            .metadata()
            .is_ok_and(|metadata| metadata.len() <= MAX_TEXT_FILE_BYTES)
            && let Ok(content) = ensure_text_file(entry.path())
        {
            let normalized_content = if parsed.smart_case {
                content.clone()
            } else {
                content.to_lowercase()
            };
            if !normalized_terms.is_empty()
                && normalized_terms
                    .iter()
                    .all(|term| normalized_content.contains(term))
            {
                for (index, line) in content.lines().enumerate() {
                    let candidate = if parsed.smart_case {
                        line.to_owned()
                    } else {
                        line.to_lowercase()
                    };
                    let matched_terms = normalized_terms
                        .iter()
                        .filter(|term| candidate.contains(term.as_str()))
                        .count();
                    if matched_terms > 0 {
                        let trimmed = line.trim_start();
                        let rank = if definition_pattern.is_match(trimmed) {
                            0
                        } else if import_pattern.is_match(trimmed) {
                            2
                        } else {
                            1
                        };
                        let snippet = line.chars().take(240).collect::<String>();
                        content_hits.push((
                            relative.clone(),
                            index + 1,
                            rank,
                            matched_terms,
                            boost,
                            snippet,
                        ));
                    }
                }
            }
        }
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
    let mut results = path_hits
        .into_iter()
        .map(|(path, _)| format!("{path}: path"))
        .collect::<Vec<_>>();
    results.extend(
        content_hits
            .into_iter()
            .map(|(path, line, _, _, _, snippet)| format!("{path}:{line}: {snippet}")),
    );
    results.truncate(limit);
    Ok(ToolResult::success(
        format!(
            "search {}",
            if query.trim().is_empty() {
                string_arg(input, &["path", "directory", "filePath"])
            } else {
                query
            }
        ),
        if results.is_empty() {
            "No matches for all search terms. Try fewer terms or a broader path. Use only exact result paths; list a directory with read before choosing a file.".into()
        } else {
            results.join("\n")
        },
    ))
}
