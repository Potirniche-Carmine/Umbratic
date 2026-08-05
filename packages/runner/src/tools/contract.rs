use std::collections::BTreeSet;

use serde_json::json;

use super::{ToolCall, catalog::ContractViolation, request::ToolRequest, surface::tool_surface};
use crate::session::Session;

/// Validates a whole parallel batch before any call in it executes. Per-call
/// argument checking is the generated validator in `catalog.rs`, reached through
/// `ToolRequest::parse`; this layer adds only the batch-level rules.
pub(crate) fn validate_tool_call_batch(
    session: &Session,
    calls: &[ToolCall],
) -> Result<(), ContractViolation> {
    const MAX_CALLS_PER_RESPONSE: usize = 16;
    if calls.is_empty() {
        return Ok(());
    }
    let surface = tool_surface(session);
    let batch_violation = |expected: String| ContractViolation {
        code: "invalid_arguments",
        tool: "batch".to_owned(),
        field: None,
        expected,
        allowed_fields: Vec::new(),
    };
    if calls.len() > MAX_CALLS_PER_RESPONSE {
        return Err(batch_violation(format!(
            "at most {MAX_CALLS_PER_RESPONSE} tool calls in one response"
        )));
    }
    let mut ids = BTreeSet::new();
    let mut signatures = BTreeSet::new();
    for call in calls {
        if !ids.insert(call.id.clone()) {
            return Err(batch_violation("a unique id for each tool call".to_owned()));
        }
        let request = ToolRequest::parse(
            &call.name,
            &call.arguments,
            &session.config.cwd,
            surface.as_ref(),
        )?;
        let signature = json!({"name": call.name, "arguments": request.arguments()}).to_string();
        if !signatures.insert(signature) {
            return Err(batch_violation(format!(
                "no repeated {} call in the same response",
                call.name
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::catalog::{TOOLS, definition};
    use super::*;

    fn surface_for(directory: &std::path::Path) -> std::sync::Arc<super::super::ToolSurface> {
        tool_surface(&crate::session::test_session(directory))
    }

    #[test]
    fn generated_validation_rejects_unknown_missing_and_out_of_range_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let surface = surface_for(directory.path());
        for invalid in [
            json!({}),                               // missing required path
            json!({"path": "a.rs", "extra": true}),  // undeclared field
            json!({"path": 7}),                      // wrong type
            json!({"path": "a.rs", "limit": 0}),     // below declared minimum
            json!({"path": "a.rs", "limit": 2_001}), // above the real maximum
        ] {
            assert!(
                surface
                    .validate("read", invalid.as_object().unwrap())
                    .is_err(),
                "read accepted {invalid}"
            );
        }
        assert!(
            surface
                .validate(
                    "read",
                    json!({"path": "a.rs", "limit": 2_000}).as_object().unwrap()
                )
                .is_ok()
        );
    }

    #[test]
    fn every_declared_limit_is_enforced_by_the_generated_validator() {
        // The schema and the validator come from one definition, so a schema that
        // declares a bound the executor does not enforce cannot exist.
        let directory = tempfile::tempdir().unwrap();
        let surface = surface_for(directory.path());
        for spec in surface.specs() {
            let name = spec["function"]["name"].as_str().unwrap();
            let tool = definition(name).expect("declared tool is in the catalog");
            let properties = &spec["function"]["parameters"]["properties"];
            for field in tool.fields {
                assert!(
                    properties.get(field.name).is_some(),
                    "{name}.{} is validated but not declared",
                    field.name
                );
            }
            let declared = properties.as_object().unwrap().len();
            assert_eq!(
                declared,
                tool.fields.len(),
                "{name} declares fields the validator does not know"
            );
        }
    }

    #[test]
    fn the_catalog_declares_each_tool_once() {
        let mut names = BTreeSet::new();
        for tool in TOOLS {
            assert!(names.insert(tool.name), "{} is defined twice", tool.name);
        }
    }

    #[test]
    fn a_batch_rejects_duplicate_ids_repeats_and_oversize() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let call = |id: &str, path: &str| ToolCall {
            id: id.into(),
            name: "read".into(),
            arguments: json!({"path": path}),
            index: 0,
        };
        assert!(
            validate_tool_call_batch(&session, &[call("a", "one.rs"), call("b", "two.rs")]).is_ok()
        );
        assert!(
            validate_tool_call_batch(&session, &[call("a", "one.rs"), call("a", "two.rs")])
                .is_err()
        );
        assert!(
            validate_tool_call_batch(&session, &[call("a", "one.rs"), call("b", "one.rs")])
                .is_err()
        );
        let oversize = (0..17)
            .map(|index| call(&format!("call-{index}"), &format!("file-{index}.rs")))
            .collect::<Vec<_>>();
        assert!(validate_tool_call_batch(&session, &oversize).is_err());
    }

    #[test]
    fn an_undeclared_tool_is_rejected_before_execution() {
        let directory = tempfile::tempdir().unwrap();
        let surface = surface_for(directory.path());
        assert!(
            surface
                .validate(
                    "search_files",
                    json!({"query": "anything"}).as_object().unwrap()
                )
                .is_err()
        );
    }
}
