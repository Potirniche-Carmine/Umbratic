use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use regex::Regex;
use sha2::{Digest, Sha256};

pub const POLICY_VERSION: &str = "umbratic-enterprise-mvp-2";

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
        ".venv/",
        "venv/",
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
    let names = [
        "__pycache__",
        "cmakefiles",
        ".ds_store",
        "thumbs.db",
        "desktop.ini",
    ];
    let extensions = [
        "pyc", "pyo", "o", "obj", "a", "lib", "so", "dylib", "dll", "exe", "pdb",
    ];
    let basename = parts.last().map(String::as_str).unwrap_or("");
    let extension = basename.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    prefixes.iter().any(|prefix| normalized.starts_with(prefix))
        || parts.iter().any(|part| names.contains(&part.as_str()))
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
        || normalized.contains("credential")
        || normalized.contains("secret")
        || normalized.contains("token")
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
    if let Some(root) = cwd {
        static ABSOLUTE_PATH: OnceLock<Regex> = OnceLock::new();
        let absolute = ABSOLUTE_PATH.get_or_init(|| {
            Regex::new(if cfg!(windows) {
                r#"(?i)(?:[A-Z]:\\|\\\\)[^\s\"'`<>|;&]*"#
            } else {
                r#"/(?:[^\s\"'`<>|;&]+)"#
            })
            .expect("static absolute-path regex must compile")
        });
        if absolute
            .find_iter(trimmed)
            .any(|found| !path_inside(root, Path::new(found.as_str())))
        {
            return CommandClassification {
                command_class: "external-directory",
                risky: true,
                reason: Some("external path"),
            };
        }
    }
    if regex(
        r"(?i)\brm\s+(-\S*r\S*f|-\S*f\S*r)\b|\bRemove-Item\b|\b(del|erase|rmdir)\b|\bgit(?:\.exe)?\b.*\b(reset\s+--hard|clean\s+-\S*f|branch\s+(?:-D|--delete\s+--force)|worktree\s+(?:remove|prune)|push\s+.*(?:--force|-f|--force-with-lease))\b",
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
    let first = trimmed
        .trim_start_matches(|c: char| c.is_whitespace() || c == '\'' || c == '"')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        first.as_str(),
        "cat" | "type" | "dir" | "ls" | "find" | "where"
    ) {
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
        assert!(is_generated_runtime_path("src/__pycache__/x.pyc"));
        assert!(is_generated_runtime_path(
            "%SystemDrive%/ProgramData/Microsoft/Windows/Caches/cversions.2.db"
        ));
        assert!(is_blocked_path(".env.local"));
        assert!(is_blocked_path("certs/client.key"));
        assert!(!is_blocked_path("src/main.rs"));
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
}
