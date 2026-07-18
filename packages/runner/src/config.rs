use std::{collections::BTreeMap, env, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

pub const RUNNER_TOOL_NAMES: [&str; 6] = [
    "read",
    "write",
    "edit",
    "search",
    "workspace_graph",
    "command",
];
const DEFAULT_CONTEXT_LENGTH: u64 = 64_000;
const DEFAULT_RESERVED_TOKENS: u64 = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Normal,
    Bypass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelBoundary {
    Development,
    Managed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSkillConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub source: String,
    pub instruction_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DiagnosticsConfig {
    pub enabled: bool,
    pub log_path: Option<PathBuf>,
    pub directory: Option<PathBuf>,
    pub include_tool_output: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MtlsConfig {
    pub ca_path: Option<PathBuf>,
    pub cert_path: Option<PathBuf>,
    pub key_path: Option<PathBuf>,
    pub server_name: Option<String>,
    pub pinned_server_certificate_sha256: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub chat_endpoint_path: Option<String>,
    pub api_key: String,
    pub model_id: String,
    pub headers: BTreeMap<String, String>,
    pub mtls: Option<MtlsConfig>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceGraphConfig {
    pub artifact_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    pub task_id: Option<String>,
    pub cwd: PathBuf,
    pub context_length: u64,
    pub max_response_tokens: u64,
    pub protected_prompt_reserve_tokens: u64,
    pub workspace_mode: String,
    pub model_boundary: ModelBoundary,
    pub skills: Vec<RunnerSkillConfig>,
    pub permission_mode: PermissionMode,
    pub enabled_tools: Vec<String>,
    pub workspace_graph: Option<WorkspaceGraphConfig>,
    pub diagnostics: DiagnosticsConfig,
    pub provider: ProviderConfig,
}

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "runner config must be a JSON object".to_owned())
}

fn string_value(value: Option<&Value>, name: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("runner config missing {name}"))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn positive_integer(value: Option<&Value>, fallback: u64) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn configured_endpoint_url(base_url: &str, endpoint_path: Option<&str>) -> Result<Url, String> {
    let base = base_url.trim_end_matches('/');
    let Some(route) = endpoint_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        let suffix = if Url::parse(base)
            .map_err(|error| error.to_string())?
            .path()
            .ends_with("/v1")
        {
            "chat/completions"
        } else {
            "v1/chat/completions"
        };
        return Url::parse(&format!("{base}/{suffix}")).map_err(|error| error.to_string());
    };
    if route.starts_with("http://") || route.starts_with("https://") {
        return Url::parse(route).map_err(|error| error.to_string());
    }
    let parsed_base = Url::parse(base).map_err(|error| error.to_string())?;
    let mut normalized = route.trim_start_matches('/').to_owned();
    let base_segment = parsed_base
        .path_segments()
        .and_then(Iterator::last)
        .unwrap_or("");
    let route_segment = normalized.split('/').next().unwrap_or("");
    if !base_segment.is_empty() && base_segment == route_segment {
        normalized = normalized.split('/').skip(1).collect::<Vec<_>>().join("/");
    }
    Url::parse(&format!("{base}/{normalized}")).map_err(|error| error.to_string())
}

pub fn provider_endpoint_url(provider: &ProviderConfig) -> Result<Url, String> {
    configured_endpoint_url(&provider.base_url, provider.chat_endpoint_path.as_deref())
}

fn validate_provider(provider: &ProviderConfig, _boundary: ModelBoundary) -> Result<(), String> {
    if provider.id != "company-endpoint" {
        return Err("provider id must be company-endpoint".to_owned());
    }
    let base = Url::parse(&provider.base_url)
        .map_err(|error| format!("invalid provider baseURL: {error}"))?;
    if base.scheme() != "http" && base.scheme() != "https" {
        return Err(format!(
            "provider baseURL must be an HTTP(S) endpoint: {}",
            provider.base_url
        ));
    }
    let loopback = matches!(base.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if base.scheme() == "http" && !loopback {
        return Err("remote provider baseURL must use HTTPS".to_owned());
    }
    if provider.chat_endpoint_path.as_deref().is_some_and(|path| {
        let path = path.trim().to_ascii_lowercase();
        path.starts_with("http://") || path.starts_with("https://")
    }) {
        return Err("runner provider chatEndpointPath must be a relative Veil route".to_owned());
    }
    let endpoint = provider_endpoint_url(provider)?;
    let path = endpoint.path().trim_end_matches('/').to_ascii_lowercase();
    if !matches!(
        path.as_str(),
        "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
    ) {
        return Err("runner provider must target an approved Veil chat route".to_owned());
    }
    Ok(())
}

fn parse_skills(value: Option<&Value>) -> Vec<RunnerSkillConfig> {
    let mut skills = BTreeMap::new();
    for item in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(skill) = item.as_object() else {
            continue;
        };
        let Some(id) = optional_string(skill.get("id")) else {
            continue;
        };
        if id.len() > 96
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let Some(name) = optional_string(skill.get("name")) else {
            continue;
        };
        let Some(instruction_path) = optional_string(skill.get("instructionPath")) else {
            continue;
        };
        let Some(source @ ("system" | "local")) = skill.get("source").and_then(Value::as_str)
        else {
            continue;
        };
        skills.insert(
            id.clone(),
            RunnerSkillConfig {
                id,
                name,
                description: optional_string(skill.get("description")).unwrap_or_default(),
                source: source.to_owned(),
                instruction_path: PathBuf::from(instruction_path),
            },
        );
    }
    skills.into_values().collect()
}

fn parse_diagnostics(value: Option<&Value>) -> DiagnosticsConfig {
    if value == Some(&Value::Bool(false)) {
        return DiagnosticsConfig {
            enabled: false,
            log_path: None,
            directory: None,
            include_tool_output: "stderr".to_owned(),
        };
    }
    let object = value.and_then(Value::as_object);
    let include = object
        .and_then(|value| value.get("includeToolOutput"))
        .and_then(Value::as_str)
        .unwrap_or("stderr");
    DiagnosticsConfig {
        enabled: object
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            != Some(false),
        log_path: object
            .and_then(|value| optional_string(value.get("logPath")))
            .map(PathBuf::from),
        directory: object
            .and_then(|value| optional_string(value.get("directory")))
            .map(PathBuf::from),
        include_tool_output: if matches!(include, "all" | "none" | "stderr") {
            include
        } else {
            "stderr"
        }
        .to_owned(),
    }
}

fn parse_mtls(value: &Value) -> Result<MtlsConfig, String> {
    let value = value
        .as_object()
        .ok_or_else(|| "invalid provider.mtls: expected object".to_owned())?;
    if value.contains_key("pfxPath") || value.contains_key("passphrase") {
        return Err(
            "invalid provider.mtls: PKCS#12/PFX is not supported; use certPath/keyPath PEM files"
                .to_owned(),
        );
    }
    Ok(MtlsConfig {
        ca_path: optional_string(value.get("caPath")).map(PathBuf::from),
        cert_path: optional_string(value.get("certPath")).map(PathBuf::from),
        key_path: optional_string(value.get("keyPath")).map(PathBuf::from),
        server_name: optional_string(value.get("serverName")),
        pinned_server_certificate_sha256: optional_string(
            value.get("pinnedServerCertificateSha256"),
        ),
    })
}

pub fn load_runner_config() -> Result<RunnerConfig, String> {
    let raw = env::var("UMBRATIC_RUNNER_CONFIG")
        .map_err(|_| "UMBRATIC_RUNNER_CONFIG is required".to_owned())?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid runner config JSON: {error}"))?;
    let config = object(&value)?;
    let provider_value = config
        .get("provider")
        .ok_or_else(|| "runner config missing provider".to_owned())?;
    let provider_object = object(provider_value)?;
    let model_boundary = match config.get("modelBoundary").and_then(Value::as_str) {
        Some("managed") => ModelBoundary::Managed,
        Some("development") => ModelBoundary::Development,
        _ if env::var("NODE_ENV").ok().as_deref() == Some("production") => ModelBoundary::Managed,
        _ => ModelBoundary::Development,
    };
    if config
        .get("system")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("runner config must not include a client system prompt".to_owned());
    }
    let provider_id = optional_string(provider_object.get("id")).unwrap_or_default();
    if model_boundary == ModelBoundary::Managed && provider_id != "company-endpoint" {
        return Err("managed runner config requires provider.id company-endpoint".to_owned());
    }
    let headers = provider_object
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .map(|value| (name.trim().to_owned(), value.to_owned()))
                })
                .filter(|(name, _)| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mtls = provider_object
        .get("mtls")
        .filter(|value| !value.is_null())
        .map(parse_mtls)
        .transpose()?;
    let provider = ProviderConfig {
        id: optional_string(provider_object.get("id"))
            .unwrap_or_else(|| "company-endpoint".to_owned()),
        name: string_value(provider_object.get("name"), "provider.name")?,
        base_url: string_value(provider_object.get("baseURL"), "provider.baseURL")?
            .trim_end_matches('/')
            .to_owned(),
        chat_endpoint_path: optional_string(provider_object.get("chatEndpointPath")),
        api_key: provider_object
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_owned(),
        model_id: string_value(provider_object.get("modelId"), "provider.modelId")?,
        headers,
        mtls,
    };
    validate_provider(&provider, model_boundary)?;
    let enabled_set = config
        .get("enabledTools")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let enabled_tools = RUNNER_TOOL_NAMES
        .iter()
        .filter(|name| {
            enabled_set
                .as_ref()
                .is_none_or(|values| values.contains(name))
        })
        .map(|value| (*value).to_owned())
        .collect();
    Ok(RunnerConfig {
        task_id: optional_string(config.get("taskId")),
        cwd: PathBuf::from(string_value(config.get("cwd"), "cwd")?),
        context_length: positive_integer(config.get("contextLength"), DEFAULT_CONTEXT_LENGTH),
        max_response_tokens: positive_integer(
            config.get("maxResponseTokens"),
            DEFAULT_RESERVED_TOKENS,
        ),
        protected_prompt_reserve_tokens: positive_integer(
            config.get("protectedPromptReserveTokens"),
            DEFAULT_RESERVED_TOKENS,
        ),
        workspace_mode:
            if config.get("workspaceMode").and_then(Value::as_str) == Some("worktree") {
                "worktree"
            } else {
                "local"
            }
            .to_owned(),
        model_boundary,
        skills: parse_skills(config.get("skills")),
        permission_mode: if config.get("permissionMode").and_then(Value::as_str) == Some("bypass") {
            PermissionMode::Bypass
        } else {
            PermissionMode::Normal
        },
        enabled_tools,
        workspace_graph: config
            .get("workspaceGraph")
            .and_then(Value::as_object)
            .and_then(|value| optional_string(value.get("artifactPath")))
            .map(|artifact_path| WorkspaceGraphConfig {
                artifact_path: PathBuf::from(artifact_path),
            }),
        diagnostics: parse_diagnostics(config.get("diagnostics")),
        provider,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_paths_are_normalized() {
        let provider = ProviderConfig {
            id: "company-endpoint".into(),
            name: "Veil".into(),
            base_url: "http://127.0.0.1:1234".into(),
            chat_endpoint_path: Some("/api/engineering/chat".into()),
            api_key: String::new(),
            model_id: "m".into(),
            headers: BTreeMap::new(),
            mtls: None,
        };
        assert_eq!(
            provider_endpoint_url(&provider).unwrap().as_str(),
            "http://127.0.0.1:1234/api/engineering/chat"
        );
    }

    fn provider(base_url: &str, endpoint: &str) -> ProviderConfig {
        ProviderConfig {
            id: "company-endpoint".into(),
            name: "Veil".into(),
            base_url: base_url.into(),
            chat_endpoint_path: Some(endpoint.into()),
            api_key: String::new(),
            model_id: "m".into(),
            headers: BTreeMap::new(),
            mtls: None,
        }
    }

    #[test]
    fn remote_plain_http_and_unapproved_managed_routes_are_rejected() {
        assert_eq!(
            validate_provider(
                &provider("http://example.com", "/api/engineering/chat"),
                ModelBoundary::Managed
            )
            .unwrap_err(),
            "remote provider baseURL must use HTTPS"
        );
        assert!(
            validate_provider(
                &provider("https://veil.example", "/v1/chat/completions"),
                ModelBoundary::Managed
            )
            .unwrap_err()
            .contains("approved Veil chat route")
        );
        assert!(
            validate_provider(
                &provider("https://veil.example", "/v1/chat/completions"),
                ModelBoundary::Development
            )
            .unwrap_err()
            .contains("approved Veil chat route")
        );
        assert!(
            validate_provider(
                &provider(
                    "https://veil.example",
                    "https://other.example/api/engineering/chat"
                ),
                ModelBoundary::Managed
            )
            .unwrap_err()
            .contains("relative Veil route")
        );
    }

    #[test]
    fn skill_index_filters_invalid_entries_and_deduplicates_by_id() {
        let skills = parse_skills(Some(&serde_json::json!([
            {"id":"valid","name":"First","description":"one","source":"local","instructionPath":"/one/SKILL.md"},
            {"id":"bad/id","name":"Bad","source":"local","instructionPath":"/bad/SKILL.md"},
            {"id":"valid","name":"Replacement","source":"system","instructionPath":"/two/SKILL.md"},
            {"id":"missing-path","name":"Bad","source":"local"}
        ])));
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "valid");
        assert_eq!(skills[0].name, "Replacement");
        assert_eq!(skills[0].source, "system");
    }

    #[test]
    fn diagnostics_defaults_are_bounded_and_can_be_disabled() {
        let defaults = parse_diagnostics(None);
        assert!(defaults.enabled);
        assert_eq!(defaults.include_tool_output, "stderr");
        let disabled = parse_diagnostics(Some(&Value::Bool(false)));
        assert!(!disabled.enabled);
        assert!(disabled.log_path.is_none());
        let invalid =
            parse_diagnostics(Some(&serde_json::json!({"includeToolOutput":"everything"})));
        assert_eq!(invalid.include_tool_output, "stderr");
    }

    #[test]
    fn mtls_rejects_legacy_pkcs12_fields() {
        for field in ["pfxPath", "passphrase"] {
            let value = Value::Object(
                [(field.to_owned(), Value::String("legacy-value".to_owned()))]
                    .into_iter()
                    .collect(),
            );
            assert!(parse_mtls(&value).unwrap_err().contains("PKCS#12/PFX"));
        }
    }
}
