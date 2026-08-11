//! tsconfig path-alias resolution (A3.1). Aliased imports are the common case
//! in real TypeScript workspaces; without this, most cross-file TS edges would
//! stay ambiguous.

use std::collections::HashMap;

/// Strip `//` and `/* */` comments, then trailing commas. The scanner is
/// string-literal and escape aware on purpose: a naive regex eats the `//` in
/// any URL that appears inside a string and corrupts the document.
pub fn strip_jsonc(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut characters = source.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(character) = characters.next() {
        if in_string {
            out.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => {
                in_string = true;
                out.push(character);
            }
            '/' if characters.peek() == Some(&'/') => {
                for next in characters.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if characters.peek() == Some(&'*') => {
                characters.next();
                let mut previous = '\0';
                for next in characters.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(character),
        }
    }
    remove_trailing_commas(&out)
}

fn remove_trailing_commas(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut in_string = false;
    let mut escaped = false;
    for character in source.chars() {
        if in_string {
            out.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        if character == '"' {
            in_string = true;
        }
        if matches!(character, ']' | '}') {
            while out.ends_with(char::is_whitespace) {
                out.pop();
            }
            if out.ends_with(',') {
                out.pop();
            }
        }
        out.push(character);
    }
    out
}

#[derive(Debug, Clone, Default)]
pub struct AliasConfig {
    /// Workspace-relative POSIX directory that `paths` targets resolve against.
    pub base: String,
    /// Sorted most-specific first: the prefix before `*` decides, so
    /// `@app/utils/*` is tried before `@app/*`.
    pub patterns: Vec<(String, Vec<String>)>,
}

/// Reads config files through a caller-supplied lookup so the resolver stays
/// testable and never touches the filesystem a second time.
pub struct AliasResolver<'a> {
    read: &'a dyn Fn(&str) -> Option<String>,
    cache: HashMap<String, Option<AliasConfig>>,
}

fn join_relative(base: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn parent_directory(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((head, _)) => head.to_owned(),
        None => String::new(),
    }
}

impl<'a> AliasResolver<'a> {
    pub fn new(read: &'a dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            read,
            cache: HashMap::new(),
        }
    }

    /// Walk upward from the importing file's directory; first config wins.
    /// Negative results are memoized too — most directories have no config and
    /// re-probing every one of them for every import is the slow path.
    pub fn config_for(&mut self, directory: &str) -> Option<AliasConfig> {
        if let Some(cached) = self.cache.get(directory) {
            return cached.clone();
        }
        let found = self.load_directory(directory).or_else(|| {
            if directory.is_empty() {
                None
            } else {
                self.config_for(&parent_directory(directory))
            }
        });
        self.cache.insert(directory.to_owned(), found.clone());
        found
    }

    fn load_directory(&mut self, directory: &str) -> Option<AliasConfig> {
        for name in ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"] {
            let path = if directory.is_empty() {
                name.to_owned()
            } else {
                format!("{directory}/{name}")
            };
            if let Some(config) = self.load_file(&path, &mut Vec::new()) {
                return Some(config);
            }
        }
        None
    }

    fn load_file(&mut self, path: &str, visited: &mut Vec<String>) -> Option<AliasConfig> {
        if visited.contains(&path.to_owned()) {
            return None;
        }
        visited.push(path.to_owned());
        let contents = (self.read)(path)?;
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(&contents)).ok()?;
        let directory = parent_directory(path);
        // Parent first, so the child's own baseUrl/paths override it.
        let mut config = value
            .get("extends")
            .and_then(serde_json::Value::as_str)
            .map(|parent| {
                let mut candidate = join_relative(&directory, parent);
                if !candidate.ends_with(".json") {
                    candidate.push_str(".json");
                }
                candidate
            })
            .and_then(|parent| self.load_file(&parent, visited))
            .unwrap_or_default();
        let options = value.get("compilerOptions");
        if let Some(base) = options
            .and_then(|options| options.get("baseUrl"))
            .and_then(serde_json::Value::as_str)
        {
            config.base = join_relative(&directory, base);
        }
        if let Some(paths) = options
            .and_then(|options| options.get("paths"))
            .and_then(serde_json::Value::as_object)
        {
            config.patterns = paths
                .iter()
                .map(|(pattern, targets)| {
                    let targets = targets
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    (pattern.clone(), targets)
                })
                .collect();
            config.patterns.sort_by(|left, right| {
                specificity(&right.0)
                    .cmp(&specificity(&left.0))
                    .then_with(|| left.0.cmp(&right.0))
            });
        }
        Some(config)
    }

    /// Candidate workspace-relative paths (before extension probing) for an
    /// aliased specifier, most specific pattern first.
    pub fn candidates(&mut self, importer: &str, specifier: &str) -> Vec<String> {
        let Some(config) = self.config_for(&parent_directory(importer)) else {
            return Vec::new();
        };
        for (pattern, targets) in &config.patterns {
            let Some(capture) = match_pattern(pattern, specifier) else {
                continue;
            };
            return targets
                .iter()
                .map(|target| join_relative(&config.base, &target.replace('*', &capture)))
                .collect();
        }
        Vec::new()
    }
}

fn specificity(pattern: &str) -> usize {
    pattern.split('*').next().unwrap_or(pattern).len()
}

fn match_pattern(pattern: &str, specifier: &str) -> Option<String> {
    match pattern.split_once('*') {
        Some((prefix, suffix)) => {
            let rest = specifier.strip_prefix(prefix)?;
            let capture = rest.strip_suffix(suffix)?;
            Some(capture.to_owned())
        }
        None => (pattern == specifier).then(String::new),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_stripping_preserves_urls_inside_strings() {
        let stripped = strip_jsonc("{\n // note\n \"a\": \"https://x/y\", /* c */\n}");
        let value: serde_json::Value = serde_json::from_str(&stripped).expect("valid json");
        assert_eq!(value["a"], "https://x/y");
    }

    #[test]
    fn more_specific_alias_patterns_win() {
        let files = |path: &str| {
            (path == "tsconfig.json").then(|| {
                "{\"compilerOptions\":{\"baseUrl\":\".\",\"paths\":{\"@app/*\":[\"src/*\"],\"@app/utils/*\":[\"src/lib/utils/*\"]}}}"
                    .to_owned()
            })
        };
        let mut resolver = AliasResolver::new(&files);
        assert_eq!(
            resolver.candidates("src/a.ts", "@app/utils/date"),
            vec!["src/lib/utils/date".to_owned()]
        );
        assert_eq!(
            resolver.candidates("src/a.ts", "@app/other"),
            vec!["src/other".to_owned()]
        );
    }

    #[test]
    fn extends_chains_are_followed_and_cycles_terminate() {
        let files = |path: &str| {
            match path {
            "tsconfig.json" => Some("{\"extends\":\"./base.json\"}".to_owned()),
            "base.json" => Some(
                "{\"extends\":\"./tsconfig.json\",\"compilerOptions\":{\"baseUrl\":\".\",\"paths\":{\"~/*\":[\"lib/*\"]}}}"
                    .to_owned(),
            ),
            _ => None,
        }
        };
        let mut resolver = AliasResolver::new(&files);
        assert_eq!(resolver.candidates("a.ts", "~/x"), vec!["lib/x".to_owned()]);
    }
}
