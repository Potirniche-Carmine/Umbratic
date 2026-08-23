//! The workspace's own `.gitignore`, honored by the discovery tools.
//!
//! `ls`, `find`, and `search` already refuse the fixed generated/blocked lists
//! in `policy.rs`; this adds what those lists cannot know — the directories a
//! particular project generates for itself (`logs/`, `tmp/`, a build output
//! the fixed list has no name for). Discovery is the only consumer: an
//! explicit `read` of a named path is a deliberate act and stays unfiltered.
//!
//! Scope is the root `.gitignore` only. Rules are evaluated in file order and
//! the last match wins, so negations (`!kept.log`) re-include what an earlier
//! line excluded — except beneath an ignored directory, which is also git's
//! rule. Nested `.gitignore` files and `.git/info/exclude` are not read; the
//! fixed lists already cover what those usually repeat.

use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};

struct Rule {
    matcher: GlobMatcher,
    negated: bool,
    /// Trailing `/` in the pattern: matches directories only.
    dir_only: bool,
    /// A `/` anywhere but the end anchors the pattern to the workspace root
    /// and matches it against the whole relative path; otherwise the pattern
    /// matches any single path component by name.
    anchored: bool,
}

#[derive(Default)]
pub(super) struct WorkspaceIgnore {
    rules: Vec<Rule>,
}

impl WorkspaceIgnore {
    /// Reads `<root>/.gitignore`. A missing or unreadable file, or an invalid
    /// line, quietly contributes nothing: discovery must not fail because a
    /// project's ignore file has a typo in it.
    pub(super) fn load(root: &Path) -> Self {
        let Ok(source) = std::fs::read_to_string(root.join(".gitignore")) else {
            return Self::default();
        };
        let mut rules = Vec::new();
        for line in source.lines() {
            let line = line.trim_end();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (negated, pattern) = match line.strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, line),
            };
            let (dir_only, pattern) = match pattern.strip_suffix('/') {
                Some(rest) => (true, rest),
                None => (false, pattern),
            };
            let anchored = pattern.contains('/');
            let pattern = pattern.strip_prefix('/').unwrap_or(pattern);
            if pattern.is_empty() {
                continue;
            }
            let Ok(glob) = GlobBuilder::new(pattern)
                .literal_separator(anchored)
                .build()
            else {
                continue;
            };
            rules.push(Rule {
                matcher: glob.compile_matcher(),
                negated,
                dir_only,
                anchored,
            });
        }
        Self { rules }
    }

    /// Whether a workspace-relative path (`/`-separated) is ignored. Every
    /// ancestor is judged as a directory first, so a file under an ignored
    /// directory is ignored no matter what later negations say about the file.
    pub(super) fn is_ignored(&self, relative: &str, is_dir: bool) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let parts: Vec<&str> = relative
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let part_is_dir = index < parts.len() - 1 || is_dir;
            let mut ignored = false;
            for rule in &self.rules {
                if rule.dir_only && !part_is_dir {
                    continue;
                }
                let matched = if rule.anchored {
                    rule.matcher.is_match(&prefix)
                } else {
                    rule.matcher.is_match(part)
                };
                if matched {
                    ignored = !rule.negated;
                }
            }
            if ignored {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher(gitignore: &str) -> (tempfile::TempDir, WorkspaceIgnore) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".gitignore"), gitignore).unwrap();
        let ignore = WorkspaceIgnore::load(directory.path());
        (directory, ignore)
    }

    #[test]
    fn a_missing_gitignore_ignores_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let ignore = WorkspaceIgnore::load(directory.path());
        assert!(!ignore.is_ignored("logs/run.log", false));
    }

    #[test]
    fn name_patterns_match_any_depth_and_anchored_patterns_match_the_root() {
        let (_directory, ignore) = matcher("logs/\n*.tmp\n/artifacts/\n");
        // A directory name matches wherever it appears; everything under it goes.
        assert!(ignore.is_ignored("logs", true));
        assert!(ignore.is_ignored("logs/run.log", false));
        assert!(ignore.is_ignored("packages/runner/logs/run.log", false));
        // An extension glob matches files at any depth.
        assert!(ignore.is_ignored("scratch.tmp", false));
        assert!(ignore.is_ignored("src/deep/scratch.tmp", false));
        // A leading slash anchors: only the root artifacts directory is out.
        assert!(ignore.is_ignored("artifacts/sbom.json", false));
        assert!(!ignore.is_ignored("packages/artifacts/Cargo.toml", false));
        // Nothing else is touched.
        assert!(!ignore.is_ignored("src/main.rs", false));
    }

    #[test]
    fn dir_only_patterns_leave_files_of_the_same_name_alone() {
        let (_directory, ignore) = matcher("build/\n");
        assert!(ignore.is_ignored("build", true));
        assert!(!ignore.is_ignored("build", false));
    }

    #[test]
    fn the_last_match_wins_and_an_ignored_directory_cannot_be_reentered() {
        let (_directory, ignore) = matcher("*.log\n!kept.log\nlogs/\n!logs/kept.log\n");
        assert!(ignore.is_ignored("run.log", false));
        // Negation re-includes a file the earlier line excluded.
        assert!(!ignore.is_ignored("kept.log", false));
        // But not beneath a directory that is itself ignored: git's rule too.
        assert!(ignore.is_ignored("logs/kept.log", false));
    }

    #[test]
    fn comments_blanks_and_invalid_globs_contribute_nothing() {
        let (_directory, ignore) = matcher("# generated\n\n[invalid\ndist2/\n");
        assert!(ignore.is_ignored("dist2/bundle.js", false));
        assert!(!ignore.is_ignored("# generated", false));
    }
}
