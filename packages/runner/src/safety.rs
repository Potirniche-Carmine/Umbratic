use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::policy::classify_command_text;

pub const COMMAND_POLICY_VERSION: &str = "command-safety-v4";
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_SEGMENTS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SafetyAction {
    Allow,
    Confirm,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SafetySeverity {
    Info,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SafetyCertainty {
    Exact,
    Heuristic,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedSpan {
    pub start: usize,
    pub end: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyDecision {
    pub policy_version: &'static str,
    pub action: SafetyAction,
    pub severity: SafetySeverity,
    pub certainty: SafetyCertainty,
    pub command_class: &'static str,
    pub rule_id: &'static str,
    pub explanation: String,
    pub matched_span: Option<MatchedSpan>,
    pub suggestion: Option<String>,
    pub command_fingerprint: String,
    pub cwd_fingerprint: String,
}

fn fingerprint(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn split_segments(command: &str) -> Result<Vec<&str>, &'static str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let bytes = command.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let character = bytes[index] as char;
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
        }
        if quote.is_none() && matches!(character, ';' | '|' | '&' | '\n') {
            if start < index && !command[start..index].trim().is_empty() {
                segments.push(command[start..index].trim());
            }
            if segments.len() >= MAX_SEGMENTS {
                return Err("too_many_segments");
            }
            if index + 1 < bytes.len() && bytes[index + 1] == bytes[index] {
                index += 1;
            }
            start = index + 1;
        }
        index += 1;
    }
    if quote.is_some() {
        return Err("unsupported_dynamic_code");
    }
    if start < command.len() && !command[start..].trim().is_empty() {
        segments.push(command[start..].trim());
    }
    if segments.len() > MAX_SEGMENTS {
        return Err("too_many_segments");
    }
    Ok(segments)
}

#[derive(Clone, Copy)]
struct DecisionSpec {
    action: SafetyAction,
    severity: SafetySeverity,
    certainty: SafetyCertainty,
    command_class: &'static str,
    rule_id: &'static str,
    explanation: &'static str,
    suggestion: Option<&'static str>,
}

fn has_output_redirect(segment: &str) -> bool {
    segment.contains('>')
}

fn is_dependency_mutation(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    let package = [
        "uv", "pip", "pip3", "npm", "pnpm", "yarn", "bun", "cargo", "go",
    ]
    .iter()
    .any(|name| {
        lower
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|token| token == *name)
    });
    let mutating = ["install", "add", "update", "upgrade"].iter().any(|name| {
        lower
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '-')
            .any(|token| token == *name)
    });
    package && mutating
}

fn has_find_action(segment: &str) -> bool {
    segment.split_whitespace().any(|token| {
        matches!(
            token.to_ascii_lowercase().as_str(),
            "-exec"
                | "-execdir"
                | "-ok"
                | "-okdir"
                | "-delete"
                | "-fls"
                | "-fprint"
                | "-fprint0"
                | "-fprintf"
        )
    })
}

fn decision(command: &str, cwd: &Path, spec: DecisionSpec) -> SafetyDecision {
    SafetyDecision {
        policy_version: COMMAND_POLICY_VERSION,
        action: spec.action,
        severity: spec.severity,
        certainty: spec.certainty,
        command_class: spec.command_class,
        rule_id: spec.rule_id,
        explanation: spec.explanation.into(),
        matched_span: (!command.is_empty()).then(|| MatchedSpan {
            start: 0,
            end: command.len().min(240),
            preview: command.chars().take(240).collect(),
        }),
        suggestion: spec.suggestion.map(str::to_owned),
        command_fingerprint: fingerprint(command.as_bytes()),
        cwd_fingerprint: fingerprint(cwd.to_string_lossy().as_bytes()),
    }
}

pub fn evaluate_command(command: &str, cwd: &Path) -> SafetyDecision {
    let trimmed = command.trim();
    if trimmed.is_empty() || command.len() > MAX_COMMAND_BYTES {
        return decision(
            command,
            cwd,
            DecisionSpec {
                action: SafetyAction::Deny,
                severity: SafetySeverity::Critical,
                certainty: SafetyCertainty::Exact,
                command_class: "unknown",
                rule_id: if trimmed.is_empty() {
                    "empty_command"
                } else {
                    "input_too_large"
                },
                explanation: "The command is empty or exceeds the bounded policy input.",
                suggestion: None,
            },
        );
    }
    let lower = trimmed.to_ascii_lowercase();
    let unresolved_path_expansion = lower.contains("$env:")
        || lower.contains("${home}")
        || lower.contains("$home")
        || lower.contains("${userprofile}")
        || lower.contains("$userprofile")
        || lower.contains("%userprofile%")
        || lower.contains("%home%")
        || lower.starts_with("~/")
        || lower.starts_with("~\\")
        || lower.contains(" ~/")
        || lower.contains(" ~\\");
    if unresolved_path_expansion {
        return decision(
            command,
            cwd,
            DecisionSpec {
                action: SafetyAction::Deny,
                severity: SafetySeverity::High,
                certainty: SafetyCertainty::Exact,
                command_class: "external-directory",
                rule_id: "unresolved_path_expansion",
                explanation: "The command contains a path expansion that cannot be proved to stay in the workspace.",
                suggestion: Some("Use a workspace-relative path or a structured workspace tool."),
            },
        );
    }
    let destructive_root = lower.contains("rm -rf /")
        || lower.contains("rm -fr /")
        || (lower.contains("remove-item -recurse")
            && (lower.contains(" c:\\\\") || lower.contains(" /")))
        || ((lower.contains("rm -rf") || lower.contains("rm -fr"))
            && lower.contains(&cwd.to_string_lossy().to_ascii_lowercase()));
    if destructive_root {
        return decision(
            command,
            cwd,
            DecisionSpec {
                action: SafetyAction::Deny,
                severity: SafetySeverity::Critical,
                certainty: SafetyCertainty::Exact,
                command_class: "destructive-file",
                rule_id: "critical_workspace_or_root_deletion",
                explanation: "Deletion of a filesystem root or the complete active workspace is blocked.",
                suggestion: Some("Remove only explicitly reviewed workspace-relative paths."),
            },
        );
    }
    let dynamic = lower.contains("$((")
        || lower.contains("$(")
        || trimmed.contains('`')
        || lower.contains("<<")
        || lower.contains(" encodedcommand")
        || lower.starts_with("eval ");
    let segments = match split_segments(trimmed) {
        Ok(segments) => segments,
        Err(rule) => {
            return decision(
                command,
                cwd,
                DecisionSpec {
                    action: SafetyAction::Confirm,
                    severity: SafetySeverity::High,
                    certainty: SafetyCertainty::Unknown,
                    command_class: "unknown",
                    rule_id: rule,
                    explanation: "Dynamic or unusually complex shell syntax requires confirmation.",
                    suggestion: None,
                },
            );
        }
    };
    let mut strictest: Option<DecisionSpec> = None;
    for segment in &segments {
        let classified = classify_command_text(segment, Some(cwd));
        let confirm_harm = dynamic
            || has_output_redirect(segment)
            || has_find_action(segment)
            || is_dependency_mutation(segment)
            || classified.risky;
        let (action, severity, certainty, rule, explanation, suggestion) = match classified
            .command_class
        {
            "blocked-path" => (
                SafetyAction::Deny,
                SafetySeverity::Critical,
                SafetyCertainty::Heuristic,
                "blocked_workspace_path",
                "The command references a workspace path the file tools refuse, such as a private key or environment file.",
                None,
            ),
            "external-directory" => (
                SafetyAction::Deny,
                SafetySeverity::Critical,
                SafetyCertainty::Heuristic,
                "outside_workspace",
                "The command references a path outside the active workspace.",
                None,
            ),
            "network" => (
                SafetyAction::Confirm,
                SafetySeverity::High,
                SafetyCertainty::Exact,
                "network_access",
                "Network access can transmit workspace content and requires explicit approval.",
                None,
            ),
            "destructive-file" => (
                SafetyAction::Confirm,
                SafetySeverity::High,
                SafetyCertainty::Exact,
                "destructive_workspace_mutation",
                "The command can remove or discard workspace state.",
                Some("Create a checkpoint or preview the affected paths first."),
            ),
            "git-write" => (
                SafetyAction::Confirm,
                SafetySeverity::Medium,
                SafetyCertainty::Exact,
                "git_write",
                "The command mutates git state and requires approval.",
                None,
            ),
            _ if confirm_harm => (
                SafetyAction::Confirm,
                SafetySeverity::Medium,
                if dynamic {
                    SafetyCertainty::Unknown
                } else {
                    SafetyCertainty::Heuristic
                },
                if dynamic {
                    "unsupported_dynamic_code"
                } else if has_output_redirect(segment) {
                    "workspace_redirect"
                } else if has_find_action(segment) {
                    "find_action"
                } else {
                    "repository_code_execution"
                },
                "The command can mutate the workspace, reach the network, or run an unconstrained action.",
                None,
            ),
            "read" | "git-read" => (
                SafetyAction::Allow,
                SafetySeverity::Info,
                SafetyCertainty::Exact,
                "audited_read_only",
                "The command is an audited read-only operation.",
                None,
            ),
            _ => (
                SafetyAction::Allow,
                SafetySeverity::Info,
                SafetyCertainty::Heuristic,
                "workspace_command",
                "The command stays in the workspace and is not a destructive, network, or install action.",
                None,
            ),
        };
        if strictest
            .as_ref()
            .is_none_or(|current| action > current.action)
        {
            strictest = Some(DecisionSpec {
                action,
                severity,
                certainty,
                command_class: classified.command_class,
                rule_id: rule,
                explanation,
                suggestion,
            });
        }
    }
    let spec = strictest.unwrap_or(DecisionSpec {
        action: SafetyAction::Confirm,
        severity: SafetySeverity::Medium,
        certainty: SafetyCertainty::Unknown,
        command_class: "unknown",
        rule_id: "unproven_command",
        explanation: "The command requires approval.",
        suggestion: None,
    });
    decision(command, cwd, spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strictest_segment_and_unknown_code_rules_are_enforced() {
        let cwd = Path::new("/workspace");
        assert_eq!(
            evaluate_command("git status", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("git status; curl https://example.com", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("npm test", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("cargo test", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("npm install left-pad", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("curl https://example.com", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("cat notes.txt > stolen.txt", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("cd /workspace && find apps/desktop/src -name '*.ts'", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("python bubble_sort.py", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("py bubble_sort.py", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(evaluate_command("pytest", cwd).action, SafetyAction::Allow);
        assert_eq!(
            evaluate_command("uv python install 3.12", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("uv pip install example", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("uv add example", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("uv tool install ruff", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("uv run python bubble_sort.py", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("uv tool run ruff check .", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("pip install example", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("powershell -Command Get-ChildItem", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("node scripts/check-source-size.ts", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command(
                "find apps/desktop/src -type f -name '*.ts' | xargs wc -l | sort -rn | head -20",
                cwd
            )
            .action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("git ls-files apps/desktop/src/renderer", cwd).action,
            SafetyAction::Allow
        );
        assert_eq!(
            evaluate_command("git commit -am update", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("rm file.txt", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(evaluate_command("rm -rf /", cwd).action, SafetyAction::Deny);
        for command in [
            r#"Get-ChildItem "$env:USERPROFILE" -Recurse"#,
            r#"type "%USERPROFILE%\secret.txt""#,
            "cat $HOME/secret.txt",
            "cat ~/secret.txt",
        ] {
            let decision = evaluate_command(command, cwd);
            assert_eq!(decision.action, SafetyAction::Deny, "{command}");
            assert_eq!(decision.rule_id, "unresolved_path_expansion");
        }
        assert_eq!(
            evaluate_command("echo $(generated)", cwd).certainty,
            SafetyCertainty::Unknown
        );
    }

    /// Auto-safe runs `Allow` without a prompt. Deletion, redirects, find
    /// actions, and blocked paths must never be Allow. Ordinary workspace
    /// locators, tests, and scripts may be.
    #[test]
    fn the_auto_allow_boundary_excludes_harmful_commands() {
        let cwd = Path::new("/workspace");
        for command in [
            "find . -type f -exec sh -c id ;",
            r"find . -type f -exec sh -c 'id' \;",
            "find . -name x -delete",
            "cat notes.txt > stolen.txt",
        ] {
            let decision = evaluate_command(command, cwd);
            assert_ne!(decision.action, SafetyAction::Allow, "{command}");
            assert_ne!(decision.rule_id, "audited_read_only", "{command}");
        }
        for command in ["cat .env", "cat *.env", "type id_rsa"] {
            let decision = evaluate_command(command, cwd);
            assert_eq!(decision.action, SafetyAction::Deny, "{command}");
            assert_eq!(decision.command_class, "blocked-path", "{command}");
            assert_eq!(decision.rule_id, "blocked_workspace_path", "{command}");
        }
        let decision = evaluate_command(r"cat ..\..\secret.txt", cwd);
        assert_eq!(decision.action, SafetyAction::Deny);
        assert_eq!(decision.command_class, "external-directory");
        assert_eq!(decision.rule_id, "outside_workspace");
        // Ordinary locator use stays unattended.
        for command in ["ls -la src", "find . -name '*.rs'"] {
            let decision = evaluate_command(command, cwd);
            assert_eq!(decision.action, SafetyAction::Allow, "{command}");
            assert_eq!(decision.rule_id, "audited_read_only", "{command}");
        }
        for command in [
            "node scripts/check-source-size.ts",
            "npm test",
            "find apps/desktop/src | xargs wc -l",
        ] {
            let decision = evaluate_command(command, cwd);
            assert_eq!(decision.action, SafetyAction::Allow, "{command}");
        }
    }
}
