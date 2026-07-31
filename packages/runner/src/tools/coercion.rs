use std::collections::BTreeMap;

use serde_json::Value;

use super::ToolCall;

pub(crate) fn coerce_tool_call_arguments(
    calls: &mut [ToolCall],
    declared_tools: &[Value],
) -> Vec<(String, Vec<&'static str>)> {
    let declared = declared_tools
        .iter()
        .filter_map(|tool| {
            Some((
                tool.get("function")?.get("name")?.as_str()?,
                tool.get("function")?
                    .get("parameters")?
                    .get("properties")?
                    .as_object()?,
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let mut changes = Vec::new();
    for call in calls {
        let mut kinds = Vec::new();
        let mut value = call.arguments.clone();
        if let Value::String(text) = &value
            && let Ok(decoded) = serde_json::from_str::<Value>(text)
        {
            value = decoded;
            if let Value::String(nested) = &value
                && let Ok(decoded) = serde_json::from_str::<Value>(nested)
            {
                value = decoded;
                kinds.push("double_encoded_object");
            }
        }
        let Some(properties) = declared.get(call.name.as_str()) else {
            continue;
        };
        if let Some(arguments) = value.as_object_mut() {
            for (field, value) in arguments {
                let Some(schema) = properties.get(field).and_then(Value::as_object) else {
                    continue;
                };
                let expected = schema.get("type").and_then(Value::as_str);
                if expected != Some("array")
                    && let Value::Array(items) = value
                    && items.len() == 1
                {
                    *value = items[0].clone();
                    kinds.push("single_element_array");
                }
                match (expected, &*value) {
                    (Some("boolean"), Value::String(text)) if text == "true" || text == "false" => {
                        *value = Value::Bool(text == "true");
                        kinds.push("boolean_string");
                    }
                    (Some("integer"), Value::String(text)) => {
                        if let Ok(number) = text.parse::<i64>() {
                            *value = Value::Number(number.into());
                            kinds.push("integer_string");
                        } else if let Ok(number) = text.parse::<u64>() {
                            *value = Value::Number(number.into());
                            kinds.push("integer_string");
                        }
                    }
                    _ => {}
                }
            }
        }
        if !kinds.is_empty() {
            call.arguments = value;
            kinds.sort_unstable();
            kinds.dedup();
            changes.push((call.id.clone(), kinds));
        }
    }
    changes
}
