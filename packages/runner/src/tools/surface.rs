//! The tool surface presented to the model, frozen once per task.
//!
//! Everything that can vary — which capabilities are enabled, whether the LSP
//! and workspace-graph services started, which executables are approved, whether
//! the context store holds anything — is resolved at task start and never
//! recomputed. Step N therefore declares byte-identical schemas to step 1.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::catalog::{ContractViolation, Gate, TOOLS, ToolDefinition, definition};
use crate::session::Session;

#[derive(Debug)]
pub struct ToolSurface {
    /// Model-facing declarations, in stable catalog order.
    specs: Vec<Value>,
    /// Names present on this surface.
    names: Vec<String>,
    /// Approved executable ids, frozen at task start.
    programs: Vec<String>,
}

impl ToolSurface {
    pub fn specs(&self) -> &[Value] {
        &self.specs
    }

    pub fn declares(&self, name: &str) -> bool {
        self.names.iter().any(|declared| declared == name)
    }

    /// The generated validator, applied to any call on any execution path.
    pub(crate) fn validate(
        &self,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> Result<(), ContractViolation> {
        // A name the catalog knows but this task did not declare is disabled; a
        // name the catalog does not know at all is unknown. Both are terminal,
        // and each keeps its own stable code.
        let Some(tool) = definition(name) else {
            return Err(ContractViolation {
                code: "unknown_tool",
                tool: name.to_owned(),
                field: None,
                expected: "a tool declared for this task".to_owned(),
                allowed_fields: self.names.clone(),
            });
        };
        if !self.declares(name) {
            return Err(ContractViolation {
                code: "tool_disabled",
                tool: name.to_owned(),
                field: None,
                expected: "a tool enabled for this session".to_owned(),
                allowed_fields: self.names.clone(),
            });
        }
        tool.validate(arguments, &self.programs)
    }
}

fn command_description() -> String {
    let shell = if cfg!(windows) {
        "Windows PowerShell"
    } else {
        "/bin/sh"
    };
    format!(
        "Run a local workspace command in {shell} after policy and permission checks. Prefer search to locate code, read to open it, and ls or find for listing; use grep only for exact regex or context lines. Do not shell out to ripgrep or find for routine search. Optional timeoutMs has a bounded default and maximum. Output progress is coalesced; large output keeps the useful tail and remains retrievable by context hash. Send exactly command and optional timeoutMs. Do not send programId or args."
    )
}

fn run_program_description(approved_ids: &[String]) -> String {
    let mut guidance = vec![
        "Run one approved executable by id without shell lookup. Send exactly programId, optional args, and optional timeoutMs. Put one argument value in each args item. Do not repeat the executable name, use shell operators, or send a command field.".to_owned(),
    ];
    for id in approved_ids {
        let example = match id.as_str() {
            "uv" => Some(
                r#"For a Python script with uv, use {"programId":"uv","args":["run","python","path/to/script.py"]}; never pass the script path as uv's first argument."#,
            ),
            "python" => Some(
                r#"For a direct Python script, use {"programId":"python","args":["path/to/script.py"]}."#,
            ),
            "npm" => {
                Some(r#"For an npm script, use {"programId":"npm","args":["run","script-name"]}."#)
            }
            "git" => {
                Some(r#"For Git status, use {"programId":"git","args":["status","--short"]}."#)
            }
            "cmake" => {
                Some(r#"For CMake configuration, put each flag and value in a separate args item."#)
            }
            _ => None,
        };
        if let Some(example) = example {
            guidance.push(example.to_owned());
        }
    }
    guidance.join(" ")
}

fn admits(session: &Session, tool: &ToolDefinition, programs: &[String]) -> bool {
    let enabled = |name: &str| session.config.enabled_tools.iter().any(|tool| tool == name);
    match tool.gate {
        Gate::Capability(name) => enabled(name),
        Gate::Service("lsp") => enabled("lsp") && session.lsp.is_some(),
        Gate::Service("workspace_graph") => {
            enabled("workspace_graph") && session.workspace_graph.is_some()
        }
        Gate::Service(_) => false,
        Gate::ApprovedPrograms => enabled("command") && !programs.is_empty(),
        Gate::Skills => !session.config.skills.is_empty(),
        Gate::Attachments => session
            .config
            .attachment_directory
            .as_ref()
            .is_some_and(|directory| directory.is_dir()),
        // retrieve_context is declared for the whole task. When the store holds
        // nothing it answers with one stable context_not_available result rather
        // than appearing and disappearing between steps.
        Gate::Always => true,
    }
}

fn build(session: &Session) -> ToolSurface {
    let programs = session
        .config
        .approved_executables
        .iter()
        .filter(|(_, path)| path.is_file())
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut specs = Vec::new();
    let mut names = Vec::new();
    for tool in TOOLS {
        if !admits(session, tool, &programs) {
            continue;
        }
        let description = match tool.name {
            "command" => command_description(),
            "run_program" => run_program_description(&programs),
            _ => tool.description.to_owned(),
        };
        specs.push(tool.schema(&description, &programs));
        names.push(tool.name.to_owned());
    }
    ToolSurface {
        specs,
        names,
        programs,
    }
}

/// Returns the task's frozen surface, building it on first use.
pub fn tool_surface(session: &Session) -> Arc<ToolSurface> {
    session
        .tool_surface
        .get_or_init(|| Arc::new(build(session)))
        .clone()
}

/// The declarations sent with a provider request. `include_tools` is false only
/// for requests that must not offer tools at all; the surface itself never
/// changes within a task.
pub fn enabled_tool_specs(session: &Session, include_tools: bool) -> Vec<Value> {
    if !include_tools {
        return Vec::new();
    }
    tool_surface(session).specs().to_vec()
}
