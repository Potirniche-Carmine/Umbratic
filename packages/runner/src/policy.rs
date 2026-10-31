use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use regex::Regex;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandClassification {
    pub command_class: &'static str,
    pub risky: bool,
    pub reason: Option<&'static str>,
}

pub fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn lowercase_parts(value: &str) -> Vec<String> {
    normalize_relative_path(value)
        .split('/')
        .map(str::to_ascii_lowercase)
        .collect()
}

pub fn is_generated_runtime_path(value: &str) -> bool {
    let normalized = normalize_relative_path(value).to_ascii_lowercase();
    let parts = lowercase_parts(value);
    let prefixes = [
        ".umbratic/runtime/",
        ".umbratic/build/",
        ".umbratic/tmp/",
        ".umbratic/index/",
        ".venv/",
        "venv/",
        // Root-level only: a top-level `env/` is almost always a virtualenv
        // from `python -m venv env`, while a nested `env/` may hold real
        // configuration, so the name is not matched at any depth.
        "env/",
        "node_modules/",
        ".git/",
        ".pytest_cache/",
        ".mypy_cache/",
        ".ruff_cache/",
        "build/",
        "dist/",
        "dist-electron/",
        "target/",
        "coverage/",
        "%systemdrive%/programdata/microsoft/windows/caches/",
    ];
    // Directory names match any path component. A prefix of `node_modules/`
    // misses `apps/desktop/node_modules` and a prefix of `target/` misses
    // `packages/runner/target`. `.llama-cache` is a checked-out llama.cpp tree
    // with its own docs and node_modules; walking it is what made a folder
    // tour spend minutes on generated markdown.
    let names = [
        "__pycache__",
        "cmakefiles",
        ".ds_store",
        "thumbs.db",
        "desktop.ini",
        "node_modules",
        ".git",
        ".llama-cache",
        ".venv",
        "venv",
        "target",
        "dist",
        "dist-electron",
        "build",
        "coverage",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".eggs",
        ".conda",
        "site-packages",
        ".gradle",
        ".terraform",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".vite",
        ".turbo",
        ".parcel-cache",
        ".cache",
        ".idea",
        "vendor",
        // `.umbratic` is not here. It used to be, which hid the whole directory
        // from ls, find, and search — including `.umbratic/artifacts/`, the
        // files the artifact tool writes for the user to open. The generated
        // parts of it are hidden by the prefixes above instead, so runtime,
        // build, tmp, and index stay invisible while a produced document does
        // not.
    ];
    let extensions = [
        "pyc", "pyo", "o", "obj", "a", "lib", "so", "dylib", "dll", "exe", "pdb",
    ];
    let basename = parts.last().map(String::as_str).unwrap_or("");
    let extension = basename.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    prefixes.iter().any(|prefix| normalized.starts_with(prefix))
        || parts.iter().any(|part| names.contains(&part.as_str()))
        || parts.iter().any(|part| part.ends_with(".egg-info"))
        || matches!(basename, "cmakecache.txt" | "compile_commands.json")
        || extensions.contains(&extension)
}

pub fn is_blocked_path(value: &str) -> bool {
    let normalized = normalize_relative_path(value).to_ascii_lowercase();
    let basename = normalized.rsplit('/').next().unwrap_or("");
    normalized == ".env"
        || normalized.ends_with("/.env")
        || normalized.starts_with(".env.")
        || normalized.contains("/.env.")
        || [".pem", ".key", ".pfx", ".p12"]
            .iter()
            .any(|suffix| basename.ends_with(suffix))
        || matches!(basename, "id_rsa" | "id_ed25519" | ".npmrc")
        || normalized == ".git/config"
        || normalized.starts_with(".git/hooks/")
}

pub fn path_inside(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

/// Re-validate a resolved write target immediately before mutating the filesystem.
/// Refuses leaf or ancestor symlinks so a TOCTOU swap after permission cannot escape.
pub fn confirm_workspace_write_path(cwd: &Path, absolute: &Path) -> Result<PathBuf, String> {
    let root = cwd
        .canonicalize()
        .map_err(|error| format!("Unable to resolve workspace: {error}"))?;
    let mut cursor = PathBuf::new();
    let components: Vec<_> = absolute.components().collect();
    for (index, component) in components.iter().enumerate() {
        cursor.push(component.as_os_str());
        let is_final = index + 1 == components.len();
        if !cursor.exists() {
            if is_final {
                break;
            }
            continue;
        }
        if path_is_symlink(&cursor) {
            return Err(format!(
                "Refusing symlink, junction, or path outside workspace: {}",
                absolute.display()
            ));
        }
    }
    let normalized = canonicalize_with_existing_ancestor(absolute)
        .ok_or_else(|| "Unable to resolve workspace path".to_owned())?;
    if !path_inside(&root, &normalized) {
        return Err(format!(
            "Refusing symlink, junction, or path outside workspace: {}",
            absolute.display()
        ));
    }
    if path_is_symlink(&normalized) {
        return Err(format!(
            "Refusing symlink, junction, or path outside workspace: {}",
            absolute.display()
        ));
    }
    Ok(normalized)
}

fn canonicalize_with_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(existing.file_name()?.to_owned());
        if !existing.pop() {
            return None;
        }
    }
    let mut canonical = existing.canonicalize().ok()?;
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    Some(canonical)
}

pub fn resolve_workspace_path(cwd: &Path, file_path: &str) -> Result<(PathBuf, String), String> {
    let alias = file_path.replace('\\', "/");
    let alias_relative = if alias == "/workspace" || alias == "/workspace/" {
        Some(".")
    } else {
        alias.strip_prefix("/workspace/")
    };
    let requested = normalize_relative_path(alias_relative.unwrap_or(file_path));
    let root = cwd
        .canonicalize()
        .map_err(|error| format!("Unable to resolve workspace: {error}"))?;
    let mut absolute = if alias_relative.is_some() || !Path::new(file_path).is_absolute() {
        root.join(&requested)
    } else {
        PathBuf::from(file_path)
    };
    if alias_relative.is_none()
        && !Path::new(file_path).is_absolute()
        && !absolute.exists()
        && let Some(root_name) = root.file_name().and_then(|value| value.to_str())
    {
        let mut parts = requested.split('/');
        if parts
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case(root_name))
        {
            let fallback = root.join(parts.collect::<Vec<_>>().join("/"));
            if fallback.exists() {
                absolute = fallback
            }
        }
    }
    let normalized = canonicalize_with_existing_ancestor(&absolute)
        .ok_or_else(|| "Unable to resolve workspace path".to_owned())?;
    if !path_inside(&root, &normalized) {
        return Err(format!(
            "Refusing symlink, junction, or path outside workspace: {file_path}"
        ));
    }
    let relative = normalized
        .strip_prefix(&root)
        .unwrap_or(&normalized)
        .to_string_lossy()
        .replace('\\', "/");
    if is_blocked_path(&relative) {
        return Err(format!("Refusing blocked path: {relative}"));
    }
    Ok((normalized, relative))
}

/// Split a command segment into shell-ish tokens, dropping the quotes that
/// group them. Good enough to inspect arguments; the safety evaluator has
/// already refused unbalanced quotes and dynamic syntax by this point.
fn command_tokens(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    for character in segment.chars() {
        match character {
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => {
                quote = Some(character);
                started = true;
            }
            character if character.is_whitespace() && quote.is_none() => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            character => {
                current.push(character);
                started = true;
            }
        }
    }
    if started {
        tokens.push(current);
    }
    tokens
}

/// `find` predicates that run a program or mutate the filesystem. Their
/// presence disqualifies a segment from the audited read-only class.
const FIND_ACTION_PREDICATES: [&str; 9] = [
    "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf",
];

/// Whether an argument is worth resolving as a path. Bare words that name no
/// existing file are ignored so `grep -n secret src` is not mistaken for a
/// read of a secret.
fn looks_like_path(token: &str, cwd: Option<&Path>) -> bool {
    if token.is_empty() || token.starts_with('-') {
        return false;
    }
    let normalized = token.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or("");
    normalized.contains('/')
        || normalized.contains('.')
        || matches!(
            basename.to_ascii_lowercase().as_str(),
            "id_rsa" | "id_ed25519"
        )
        || cwd.is_some_and(|root| root.join(&normalized).exists())
}

/// Lexically decide whether a relative path climbs above the workspace root.
/// Catches the Windows separator style the absolute-path regexes never see.
fn escapes_workspace(token: &str) -> bool {
    let normalized = token.replace('\\', "/");
    let mut depth = 0i32;
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

/// Apply the file-tool blocklist to a command argument. Wildcards are stripped
/// as well as kept, so `cat *.env` is refused alongside `cat .env`.
fn token_is_blocked_path(token: &str) -> bool {
    let normalized = token.replace('\\', "/");
    let expanded: String = normalized
        .chars()
        .filter(|character| !matches!(character, '*' | '?'))
        .collect();
    is_blocked_path(&normalized) || is_blocked_path(&expanded)
}

/// Whether a token is an absolute filesystem path. A slash *inside* a relative
/// path (`apps/desktop/src`) is not one; matching those as `/desktop/src` is
/// what used to block ordinary workspace commands.
fn token_is_absolute_path(token: &str) -> bool {
    if cfg!(windows) {
        let bytes = token.as_bytes();
        (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
            || token.starts_with("\\\\")
    } else {
        token.starts_with('/')
    }
}

pub fn classify_command_text(command: &str, cwd: Option<&Path>) -> CommandClassification {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return CommandClassification {
            command_class: "unknown",
            risky: false,
            reason: None,
        };
    }
    if regex(
        r"(?i)\b(curl|wget|aria2c|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b|https?://",
        trimmed,
    ) {
        return CommandClassification {
            command_class: "network",
            risky: true,
            reason: Some("network command"),
        };
    }
    // The blocklist that guards the file tools, applied to command arguments so
    // the shell cannot read what `read` refuses.
    let tokens = command_tokens(trimmed);
    for token in tokens.iter().skip(1) {
        if !looks_like_path(token, cwd) {
            continue;
        }
        if escapes_workspace(token) {
            return CommandClassification {
                command_class: "external-directory",
                risky: true,
                reason: Some("external path"),
            };
        }
        if token_is_blocked_path(token) {
            return CommandClassification {
                command_class: "blocked-path",
                risky: true,
                reason: Some("blocked workspace path"),
            };
        }
    }
    if let Some(root) = cwd
        && tokens
            .iter()
            .any(|token| token_is_absolute_path(token) && !path_inside(root, Path::new(token)))
    {
        return CommandClassification {
            command_class: "external-directory",
            risky: true,
            reason: Some("external path"),
        };
    }
    classify_command_body(trimmed, &tokens)
}

fn regex(pattern: &'static str, value: &str) -> bool {
    static REGEXES: OnceLock<Mutex<HashMap<&'static str, Regex>>> = OnceLock::new();
    let mut regexes = REGEXES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let regex = regexes
        .entry(pattern)
        .or_insert_with(|| Regex::new(pattern).expect("static policy regex must compile"));
    regex.is_match(value)
}

/// Proven locator commands. Auto-safe runs these without a prompt; a locator
/// name is not enough, because `find` reaches an arbitrary interpreter through
/// `-exec` and deletes through `-delete`, and any of these can redirect their
/// output into a file.
fn is_audited_read_only(trimmed: &str, tokens: &[String]) -> bool {
    let Some(first) = tokens.first() else {
        return false;
    };
    let first = first.to_ascii_lowercase();
    if !matches!(
        first.as_str(),
        "cat" | "type" | "dir" | "ls" | "find" | "where"
    ) {
        return false;
    }
    if trimmed.contains('>') || trimmed.contains('<') {
        return false;
    }
    if first == "find" {
        let predicates: Vec<String> = tokens
            .iter()
            .map(|token| token.to_ascii_lowercase())
            .collect();
        if predicates
            .iter()
            .any(|token| FIND_ACTION_PREDICATES.contains(&token.as_str()))
        {
            return false;
        }
    }
    true
}

fn classify_command_body(trimmed: &str, tokens: &[String]) -> CommandClassification {
    if regex(
        r"(?i)\brm\b|\bRemove-Item\b|\b(del|erase|rmdir)\b|\bgit(?:\.exe)?\b.*\b(reset\s+--hard|clean\s+-\S*f|branch\s+(?:-D|--delete\s+--force)|worktree\s+(?:remove|prune)|push\s+.*(?:--force|-f|--force-with-lease))\b",
        trimmed,
    ) {
        return CommandClassification {
            command_class: "destructive-file",
            risky: true,
            reason: Some("destructive command"),
        };
    }
    if regex(
        r#"(?i)^(?:run\s+)?["']?(python|python3|py)["']?(?:\s|$)|\b(uv|pytest|pip|pip3|\.venv[/\\](?:scripts[/\\])?python)\b"#,
        trimmed,
    ) {
        return CommandClassification {
            command_class: "python-runtime",
            risky: false,
            reason: None,
        };
    }
    if regex(r"(?i)\bgit(?:\.exe)?\b", trimmed) {
        let read = regex(
            r#"(?i)\bgit(?:\.exe)?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))*\s+(status|diff|show|log|reflog|rev-parse|ls-files|cat-file|show-ref|blame|grep|describe|merge-base|name-rev|for-each-ref|remote\s+(?:-v|show)|worktree\s+list|stash\s+list|tag\s+(?:--list|-l)|branch\s+(?:--show-current|--list|-a|-r|-v|-vv|--contains|--merged|--no-merged)|config\s+(?:--get|--get-regexp|--list|--show-origin)|submodule\s+status)\b"#,
            trimmed,
        );
        return CommandClassification {
            command_class: if read { "git-read" } else { "git-write" },
            risky: !read,
            reason: None,
        };
    }
    if regex(r"(?i)\b(cmake|ctest|ninja|make|msbuild)\b", trimmed) {
        return CommandClassification {
            command_class: "cmake-build",
            risky: false,
            reason: None,
        };
    }
    if regex(r"(?i)\b(cl|clang|clang\+\+|gcc|g\+\+)\b", trimmed) {
        return CommandClassification {
            command_class: "compiler",
            risky: false,
            reason: None,
        };
    }
    if regex(r"(?i)\b(npm|pnpm|yarn|bun|cargo|go|dotnet)\b", trimmed) {
        let risky = regex(r"(?i)\b(install|add|update|upgrade|global|-g)\b", trimmed);
        return CommandClassification {
            command_class: "package-manager",
            risky,
            reason: Some("package manager"),
        };
    }
    if regex(
        r"(?i)\b(markdownlint|remark|prettier)\b|\.(md|markdown)\b",
        trimmed,
    ) {
        return CommandClassification {
            command_class: "markdown",
            risky: false,
            reason: None,
        };
    }
    if is_audited_read_only(trimmed, tokens) {
        return CommandClassification {
            command_class: "read",
            risky: false,
            reason: None,
        };
    }
    CommandClassification {
        command_class: "shell",
        risky: false,
        reason: None,
    }
}

fn redact_secrets(value: &str) -> String {
    let private_key = Regex::new(r"(?s)-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----.*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----").unwrap();
    let generic = Regex::new(
        r#"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*[\"']?[A-Za-z0-9_./+=-]{12,}"#,
    )
    .unwrap();
    let aws = Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap();
    let github = Regex::new(r"\bgh[pousr]_[A-Za-z0-9_]{30,}\b").unwrap();
    let bearer = Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}").unwrap();
    let text = private_key.replace_all(value, "[redacted-private-key]");
    let text = generic.replace_all(&text, "$1=[redacted]");
    let text = aws.replace_all(&text, "[redacted-aws-key]");
    let text = github.replace_all(&text, "[redacted-github-token]");
    bearer.replace_all(&text, "Bearer [redacted]").into_owned()
}

pub fn redact_text(value: &str, limit: usize) -> String {
    let text = redact_secrets(value).trim().to_owned();
    if text.chars().count() <= limit {
        text
    } else {
        format!(
            "{}...[truncated]",
            text.chars().take(limit).collect::<String>()
        )
    }
}

pub fn redact_stream_text(value: &str, limit: usize) -> String {
    let text = redact_secrets(value);
    if text.len() <= limit {
        text
    } else {
        let mut end = limit;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated]", &text[..end])
    }
}

pub fn short_hash_value(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_and_blocked_paths_are_closed() {
        assert!(is_generated_runtime_path("node_modules/a.js"));
        assert!(is_generated_runtime_path(
            "apps/desktop/node_modules/pkg/index.js"
        ));
        assert!(is_generated_runtime_path(
            "apps/desktop/.llama-cache/llama.cpp/README.md"
        ));
        assert!(is_generated_runtime_path(
            "packages/runner/target/debug/umbratic_runner"
        ));
        assert!(!is_generated_runtime_path("src/build.ts"));
        assert!(is_generated_runtime_path("src/__pycache__/x.pyc"));
        assert!(is_generated_runtime_path(
            "%SystemDrive%/ProgramData/Microsoft/Windows/Caches/cversions.2.db"
        ));
        assert!(is_blocked_path(".env.local"));
        assert!(is_blocked_path("certs/client.key"));
        assert!(is_blocked_path(".npmrc"));
        assert!(!is_blocked_path("src/main.rs"));
        assert!(!is_blocked_path("src/tokenizer.rs"));
        assert!(!is_blocked_path("docs/secret-management.md"));
        assert!(!is_blocked_path("tests/credential_store.rs"));
    }

    #[test]
    fn produced_artifacts_are_visible_while_the_runtime_beside_them_stays_hidden() {
        // A deck the artifact tool just wrote has to be findable by the tools
        // that list and search, or the model cannot hand the user a path it can
        // confirm exists. Everything else under `.umbratic` is machinery.
        assert!(!is_generated_runtime_path(
            ".umbratic/artifacts/pptx/q3-review.pptx"
        ));
        assert!(!is_generated_runtime_path(".umbratic/artifacts"));
        assert!(is_generated_runtime_path(".umbratic/runtime/runner.log"));
        assert!(is_generated_runtime_path(".umbratic/tmp/staged-1"));
        assert!(is_generated_runtime_path(".umbratic/build/out.bin"));
        assert!(is_generated_runtime_path(".umbratic/index/graph.json"));
    }

    #[test]
    fn command_classes_match_security_boundaries() {
        assert_eq!(
            classify_command_text("git status", None).command_class,
            "git-read"
        );
        assert_eq!(
            classify_command_text("git reset --hard", None).command_class,
            "destructive-file"
        );
        assert_eq!(
            classify_command_text("python script.py", None).command_class,
            "python-runtime"
        );
        assert_eq!(
            classify_command_text("curl https://example.com", None).command_class,
            "network"
        );
    }

    #[test]
    fn locator_commands_prove_themselves_before_the_read_class() {
        let workspace = std::env::temp_dir().join("umbratic-policy-workspace");
        let root = Some(workspace.as_path());
        assert_eq!(
            classify_command_text("ls -la src", root).command_class,
            "read"
        );
        assert_eq!(
            classify_command_text("find . -name '*.rs'", root).command_class,
            "read"
        );
        for command in [
            "find . -type f -exec sh -c id ;",
            r"find . -type f -exec sh -c 'id' \;",
            "find . -name x -delete",
            "find . -okdir rm {} ;",
            "cat notes.txt > stolen.txt",
        ] {
            assert_ne!(
                classify_command_text(command, root).command_class,
                "read",
                "{command}"
            );
        }
    }

    #[test]
    fn command_arguments_honor_the_file_tool_blocklist() {
        let workspace = std::env::temp_dir().join("umbratic-policy-workspace");
        let root = Some(workspace.as_path());
        for command in [
            "cat .env",
            "cat *.env",
            "ls certs/client.key",
            "type id_rsa",
        ] {
            assert_eq!(
                classify_command_text(command, root).command_class,
                "blocked-path",
                "{command}"
            );
        }
        assert_eq!(
            classify_command_text(r"cat ..\..\secret.txt", root).command_class,
            "external-directory"
        );
        assert_eq!(
            classify_command_text("cat ../../secret.txt", root).command_class,
            "external-directory"
        );
        // A bare word that names no file is an argument, not a path.
        assert_eq!(
            classify_command_text(r#"grep -n "secret" src"#, root).command_class,
            "shell"
        );
    }

    #[test]
    fn redaction_removes_tokens() {
        assert!(
            !redact_text("token=abcdefghijklmnopqrstuvwxyz", 600)
                .contains("abcdefghijklmnopqrstuvwxyz")
        );
    }

    #[test]
    fn command_classes_cover_package_reads_and_external_paths() {
        let workspace = std::env::temp_dir().join("umbratic-policy-workspace");
        assert_eq!(
            classify_command_text("npm run test", Some(&workspace)).command_class,
            "package-manager"
        );
        assert!(!classify_command_text("npm run test", Some(&workspace)).risky);
        assert!(classify_command_text("npm install left-pad", Some(&workspace)).risky);
        assert_eq!(
            classify_command_text("git commit -am update", Some(&workspace)).command_class,
            "git-write"
        );
        #[cfg(unix)]
        assert_eq!(
            classify_command_text("cat /etc/hosts", Some(&workspace)).command_class,
            "external-directory"
        );
        assert_eq!(
            classify_command_text("find apps/desktop/src -name '*.ts'", Some(&workspace))
                .command_class,
            "read"
        );
        assert_eq!(
            classify_command_text("node scripts/check-source-size.ts", Some(&workspace))
                .command_class,
            "shell"
        );
        assert_eq!(
            classify_command_text("git ls-files apps/desktop/src/renderer", Some(&workspace))
                .command_class,
            "git-read"
        );
        let inside = format!("cd {} && ls", workspace.display());
        assert_ne!(
            classify_command_text(&inside, Some(&workspace)).command_class,
            "external-directory"
        );
    }

    #[test]
    fn workspace_resolution_handles_symlinked_temporary_roots() {
        let directory = tempfile::tempdir().unwrap();
        let (target, relative) = resolve_workspace_path(directory.path(), "notes/new.txt").unwrap();
        assert_eq!(relative, "notes/new.txt");
        assert!(target.starts_with(directory.path().canonicalize().unwrap()));
        assert!(resolve_workspace_path(directory.path(), "../outside.txt").is_err());
        assert!(resolve_workspace_path(directory.path(), ".env").is_err());
    }

    #[test]
    fn workspace_resolution_accepts_an_absolute_new_file_path() {
        let directory = tempfile::tempdir().unwrap();
        let requested = directory.path().join("bubble_sort.py");
        let (target, relative) =
            resolve_workspace_path(directory.path(), requested.to_str().unwrap()).unwrap();

        assert_eq!(relative, "bubble_sort.py");
        assert_eq!(
            target,
            directory
                .path()
                .canonicalize()
                .unwrap()
                .join("bubble_sort.py")
        );
    }

    #[test]
    fn write_confirmation_rejects_symlink_leaves() {
        let parent = tempfile::tempdir().unwrap();
        // Canonicalize first: macOS hands out temporary directories under the
        // /var symlink, which this function rejects by design.
        let root = parent.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let outside = root.join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        let link = workspace.join("link.txt");
        let created = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&outside, &link).is_ok()
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_file(&outside, &link).is_ok()
            }
        };
        if created {
            let err = confirm_workspace_write_path(&workspace, &link).unwrap_err();
            assert!(err.to_ascii_lowercase().contains("symlink"), "{err}");
        }
        let safe = workspace.join("safe.txt");
        let confirmed = confirm_workspace_write_path(&workspace, &safe).unwrap();
        assert_eq!(
            confirmed,
            workspace.canonicalize().unwrap().join("safe.txt")
        );
    }
}
