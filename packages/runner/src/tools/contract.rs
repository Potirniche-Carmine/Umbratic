use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::{
    ToolCall,
    request::{ToolRequest, parse_arguments},
};
use crate::{policy::redact_text, session::Session};

pub(crate) fn validate_tool_call_batch(
    session: &Session,
    calls: &[ToolCall],
    declared_tools: &[Value],
) -> Result<(), String> {
    const MAX_CALLS_PER_RESPONSE: usize = 16;
    if calls.is_empty() {
        return Ok(());
    }
    if calls.len() > MAX_CALLS_PER_RESPONSE {
        return Err(format!(
            "A model response can contain at most {MAX_CALLS_PER_RESPONSE} tool calls."
        ));
    }
    let declared = declared_tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("function")?.get("name")?.as_str()?;
            Some((name.to_owned(), tool))
        })
        .collect::<BTreeMap<_, _>>();
    let mut ids = BTreeSet::new();
    let mut signatures = BTreeSet::new();
    for call in calls {
        if !ids.insert(call.id.clone()) {
            return Err(format!("Duplicate tool call id: {}.", call.id));
        }
        let Some(declaration) = declared.get(&call.name) else {
            return Err(format!(
                "Tool {} is not declared for this response.",
                redact_text(&call.name, 80)
            ));
        };
        let arguments = parse_arguments(&call.arguments)
            .map_err(|error| format!("Invalid {} call: {error}", call.name))?;
        validate_declared_arguments(declaration, &arguments)
            .map_err(|error| format!("Invalid {} call: {error}", call.name))?;
        ToolRequest::parse(&call.name, &call.arguments, &session.config.cwd)
            .map_err(|error| format!("Invalid {} call: {error}", call.name))?;
        if call.name == "run_program" {
            let program_id = arguments
                .get("programId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !session.config.approved_executables.contains_key(program_id) {
                return Err(format!(
                    "run_program programId {} is not declared for this response.",
                    redact_text(program_id, 80)
                ));
            }
        }
        let signature = json!({"name":call.name,"arguments":arguments}).to_string();
        if !signatures.insert(signature) {
            return Err(format!(
                "The response contains the same {} tool call more than once.",
                call.name
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_declared_arguments(
    declaration: &Value,
    arguments: &Map<String, Value>,
) -> Result<(), String> {
    let parameters = declaration
        .get("function")
        .and_then(|function| function.get("parameters"))
        .and_then(Value::as_object)
        .ok_or_else(|| "declared parameters are not an object schema".to_owned())?;
    let properties = parameters
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "declared properties are not an object".to_owned())?;
    let required = parameters
        .get("required")
        .and_then(Value::as_array)
        .ok_or_else(|| "declared required fields are not an array".to_owned())?;

    for field in required {
        let name = field
            .as_str()
            .ok_or_else(|| "a declared required field is not a string".to_owned())?;
        if !arguments.contains_key(name) {
            return Err(format!("missing required argument {name}"));
        }
    }
    for (name, value) in arguments {
        let schema = properties
            .get(name)
            .ok_or_else(|| format!("received undeclared argument {name}"))?;
        validate_value(name, value, schema)?;
    }
    Ok(())
}

fn validate_value(path: &str, value: &Value, schema: &Value) -> Result<(), String> {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        return Err(format!("{path} is not one of the declared values"));
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => validate_string(path, value, schema),
        Some("integer") => validate_integer(path, value, schema),
        Some("boolean") if value.is_boolean() => Ok(()),
        Some("boolean") => Err(format!("{path} must be a boolean")),
        Some("array") => validate_array(path, value, schema),
        Some("object") if value.is_object() => Ok(()),
        Some("object") => Err(format!("{path} must be an object")),
        Some(kind) => Err(format!("{path} uses unsupported declared type {kind}")),
        None => Err(format!("{path} has no declared type")),
    }
}

fn validate_string(path: &str, value: &Value, schema: &Value) -> Result<(), String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{path} must be a string"))?;
    let length = text.chars().count() as u64;
    if schema
        .get("minLength")
        .and_then(Value::as_u64)
        .is_some_and(|minimum| length < minimum)
    {
        return Err(format!("{path} is shorter than the declared minimum"));
    }
    if schema
        .get("maxLength")
        .and_then(Value::as_u64)
        .is_some_and(|maximum| length > maximum)
    {
        return Err(format!("{path} exceeds the declared maximum length"));
    }
    Ok(())
}

fn validate_integer(path: &str, value: &Value, schema: &Value) -> Result<(), String> {
    let number = value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
        .ok_or_else(|| format!("{path} must be an integer"))?;
    if schema
        .get("minimum")
        .and_then(integer_schema_value)
        .is_some_and(|minimum| number < minimum)
    {
        return Err(format!("{path} is below the declared minimum"));
    }
    if schema
        .get("maximum")
        .and_then(integer_schema_value)
        .is_some_and(|maximum| number > maximum)
    {
        return Err(format!("{path} exceeds the declared maximum"));
    }
    Ok(())
}

fn integer_schema_value(value: &Value) -> Option<i128> {
    value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
}

fn validate_array(path: &str, value: &Value, schema: &Value) -> Result<(), String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{path} must be an array"))?;
    let length = values.len() as u64;
    if schema
        .get("minItems")
        .and_then(Value::as_u64)
        .is_some_and(|minimum| length < minimum)
    {
        return Err(format!("{path} has fewer than the declared minimum items"));
    }
    if schema
        .get("maxItems")
        .and_then(Value::as_u64)
        .is_some_and(|maximum| length > maximum)
    {
        return Err(format!("{path} exceeds the declared maximum items"));
    }
    let Some(item_schema) = schema.get("items") else {
        return Ok(());
    };
    for (index, item) in values.iter().enumerate() {
        validate_value(&format!("{path}[{index}]"), item, item_schema)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn declaration(properties: Value, required: Value) -> Value {
        json!({
            "function": {
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": false
                }
            }
        })
    }

    #[test]
    fn exact_schema_validation_rejects_unknown_missing_and_wrong_types() {
        let tool = declaration(
            json!({
                "name":{"type":"string","minLength":1},
                "count":{"type":"integer","minimum":1,"maximum":3}
            }),
            json!(["name"]),
        );
        assert!(
            validate_declared_arguments(&tool, json!({"name":"ok","count":2}).as_object().unwrap())
                .is_ok()
        );
        for invalid in [
            json!({"count":2}),
            json!({"name":"ok","extra":true}),
            json!({"name":7}),
            json!({"name":"ok","count":0}),
            json!({"name":"ok","count":4}),
        ] {
            assert!(validate_declared_arguments(&tool, invalid.as_object().unwrap()).is_err());
        }
    }

    #[test]
    fn exact_schema_validation_enforces_enums_and_array_items() {
        let tool = declaration(
            json!({
                "mode":{"type":"string","enum":["one","two"]},
                "args":{"type":"array","maxItems":2,"items":{"type":"string","maxLength":4}}
            }),
            json!(["mode"]),
        );
        assert!(
            validate_declared_arguments(
                &tool,
                json!({"mode":"one","args":["a","bc"]}).as_object().unwrap()
            )
            .is_ok()
        );
        for invalid in [
            json!({"mode":"three"}),
            json!({"mode":"one","args":"a"}),
            json!({"mode":"one","args":["a","b","c"]}),
            json!({"mode":"one","args":["12345"]}),
        ] {
            assert!(validate_declared_arguments(&tool, invalid.as_object().unwrap()).is_err());
        }
    }
}
