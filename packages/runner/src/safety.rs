use std::{
    path::Path,
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::policy::classify_command_text;

pub const COMMAND_POLICY_VERSION: &str = "command-safety-v3";
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
pub struct SafetyDecisionV1 {
    pub schema_version: u8,
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
    pub evaluation_micros: u64,
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

fn decision(command: &str, cwd: &Path, spec: DecisionSpec, started: Instant) -> SafetyDecisionV1 {
    SafetyDecisionV1 {
        schema_version: 1,
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
        evaluation_micros: started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
    }
}

pub fn evaluate_command(command: &str, cwd: &Path) -> SafetyDecisionV1 {
    let started = Instant::now();
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
            started,
        );
    }
    let lower = trimmed.to_ascii_lowercase();
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
            started,
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
                started,
            );
        }
    };
    let mut strictest: Option<DecisionSpec> = None;
    for segment in &segments {
        let classified = classify_command_text(segment, Some(cwd));
        let (action, severity, certainty, rule, explanation, suggestion) = match classified
            .command_class
        {
            "network" => (
                SafetyAction::Deny,
                SafetySeverity::Critical,
                SafetyCertainty::Exact,
                "network_denied",
                "Network transfer commands and visible network URLs are blocked.",
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
            "read" | "git-read" if !dynamic => (
                SafetyAction::Allow,
                SafetySeverity::Info,
                SafetyCertainty::Exact,
                "audited_read_only",
                "The command is an audited read-only operation.",
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
            // Interpreters, test runners, package managers, and shells always Confirm.
            // AutoSafe must not execute workspace-controlled code without approval.
            "package-manager" | "cmake-build" | "compiler" | "python-runtime" | "shell" => (
                SafetyAction::Confirm,
                SafetySeverity::Medium,
                if dynamic {
                    SafetyCertainty::Unknown
                } else {
                    SafetyCertainty::Heuristic
                },
                "repository_code_execution",
                "The command executes repository-controlled code, a shell, or changes dependencies.",
                None,
            ),
            _ => (
                SafetyAction::Confirm,
                SafetySeverity::Medium,
                if dynamic {
                    SafetyCertainty::Unknown
                } else {
                    SafetyCertainty::Heuristic
                },
                if dynamic {
                    "unsupported_dynamic_code"
                } else {
                    "unproven_command"
                },
                "The command is not proven read-only and requires one-time approval.",
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
    decision(command, cwd, spec, started)
}

#[derive(Debug)]
pub struct CommandPermit {
    command_fingerprint: String,
    cwd_fingerprint: String,
    policy_version: &'static str,
    expires_at: Instant,
}

impl CommandPermit {
    pub fn new(decision: &SafetyDecisionV1) -> Self {
        Self {
            command_fingerprint: decision.command_fingerprint.clone(),
            cwd_fingerprint: decision.cwd_fingerprint.clone(),
            policy_version: decision.policy_version,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
    }

    pub fn consume(self, command: &str, cwd: &Path) -> Result<(), &'static str> {
        if Instant::now() > self.expires_at {
            return Err("command permit expired");
        }
        if self.policy_version != COMMAND_POLICY_VERSION
            || self.command_fingerprint != fingerprint(command.as_bytes())
            || self.cwd_fingerprint != fingerprint(cwd.to_string_lossy().as_bytes())
        {
            return Err("command permit does not match command and workspace");
        }
        Ok(())
    }
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
            SafetyAction::Deny
        );
        assert_eq!(
            evaluate_command("npm test", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("python bubble_sort.py", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("py bubble_sort.py", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("pytest", cwd).action,
            SafetyAction::Confirm
        );
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
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("uv tool run ruff check .", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("pip install example", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(
            evaluate_command("powershell -Command Get-ChildItem", cwd).action,
            SafetyAction::Confirm
        );
        assert_eq!(evaluate_command("rm -rf /", cwd).action, SafetyAction::Deny);
        assert_eq!(
            evaluate_command("echo $(generated)", cwd).certainty,
            SafetyCertainty::Unknown
        );
    }

    #[test]
    fn permit_is_exact_and_single_use_by_ownership() {
        let cwd = Path::new("/workspace");
        let decision = evaluate_command("git status", cwd);
        assert!(
            CommandPermit::new(&decision)
                .consume("git status", cwd)
                .is_ok()
        );
        assert!(
            CommandPermit::new(&decision)
                .consume("git diff", cwd)
                .is_err()
        );
        assert!(
            CommandPermit::new(&decision)
                .consume("git status", Path::new("/other"))
                .is_err()
        );
        let mut expired = CommandPermit::new(&decision);
        expired.expires_at = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            expired.consume("git status", cwd),
            Err("command permit expired")
        );
        let mut stale_policy = CommandPermit::new(&decision);
        stale_policy.policy_version = "obsolete-policy";
        assert_eq!(
            stale_policy.consume("git status", cwd),
            Err("command permit does not match command and workspace")
        );
    }
}
