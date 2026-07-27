use std::{
    fs,
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{Path as AxumPath, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{StreamExt, stream};
use http_body_util::{BodyExt, Limited};
use serde_json::{Map, Value, json};
use tokio::{
    net::TcpListener,
    sync::{broadcast::error::RecvError, oneshot},
    task::JoinHandle,
};

use crate::{
    context::estimate_context_usage,
    context_state::{ContextStateV1, snapshot_context_state},
    events::now_iso,
    loop_runtime::run_turn,
    policy::redact_text,
    session::{InputPart, SessionStore},
};

const MAX_JSON_BODY_BYTES: usize = 512 * 1024;
const MAX_PROMPT_BODY_BYTES: usize = 64 * 1024 * 1024;

fn require_loopback(hostname: &str) -> Result<(), String> {
    if hostname
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
    {
        return Ok(());
    }
    Err("Runner hostname must resolve explicitly to a loopback address.".to_owned())
}

fn attachment_filename(path: &Path) -> String {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runner-diagnostics.jsonl");
    let safe = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    if safe.is_empty() {
        "runner-diagnostics.jsonl".to_owned()
    } else {
        safe
    }
}

#[derive(Clone)]
struct AppState {
    store: Arc<SessionStore>,
    password: Arc<str>,
}

pub struct RunnerServer {
    url: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    store: Arc<SessionStore>,
}

impl RunnerServer {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub async fn close(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.task.await;
        self.store.shutdown().await;
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn authorized(headers: &HeaderMap, password: &str) -> bool {
    let Some(encoded) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
    else {
        return false;
    };
    let Ok(decoded) = STANDARD.decode(encoded) else {
        return false;
    };
    constant_time_eq(&decoded, format!("umbratic-runner:{password}").as_bytes())
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    json_response(status, json!({ "error": message, "code": code }))
}

async fn boundary(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !authorized(request.headers(), &state.password) {
        let mut response = error_response(StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized");
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Basic"));
        return response;
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

async fn read_json(request: Request) -> Result<Map<String, Value>, Response> {
    read_json_with_limit(request, MAX_JSON_BODY_BYTES).await
}

async fn read_json_with_limit(
    request: Request,
    max_bytes: usize,
) -> Result<Map<String, Value>, Response> {
    let limited = Limited::new(request.into_body(), max_bytes);
    let bytes = limited
        .collect()
        .await
        .map_err(|_| {
            error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "Request body is too large.",
            )
        })?
        .to_bytes();
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        error_response(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "Request body must be valid JSON.",
        )
    })?;
    value.as_object().cloned().ok_or_else(|| {
        error_response(
            StatusCode::BAD_REQUEST,
            "invalid_json_shape",
            "Request body must be a JSON object.",
        )
    })
}

fn input_parts(body: &Map<String, Value>) -> Vec<InputPart> {
    let mut parts = Vec::new();
    for item in body
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(data_url) = item
                .get("data_url")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("data:image/"))
            {
                parts.push(InputPart::Image {
                    data_url: data_url.to_owned(),
                });
            }
        } else if let Some(text) = item
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| item.get("content").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
        {
            parts.push(InputPart::Text {
                text: text.to_owned(),
            });
        }
    }
    if parts.is_empty()
        && let Some(prompt) = body
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        parts.push(InputPart::Text {
            text: prompt.to_owned(),
        });
    }
    if parts.is_empty() {
        parts.push(InputPart::Text {
            text: String::new(),
        });
    }
    parts
}

async fn events(State(state): State<AppState>) -> impl IntoResponse {
    let connected = stream::once(async {
        Ok::<Event, std::convert::Infallible>(Event::default().comment("connected"))
    });
    let updates = stream::unfold(state.store.sink.subscribe(), |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    return Some((
                        Ok::<Event, std::convert::Infallible>(
                            Event::default().data(event.to_string()),
                        ),
                        receiver,
                    ));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(connected.chain(updates)).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}

async fn diagnostics(State(state): State<AppState>) -> Response {
    let mut metadata = state.store.diagnostic_metadata();
    let path = metadata
        .get("logPath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(path) = path {
        match fs::metadata(&path) {
            Ok(stat) => {
                metadata["exists"] = Value::Bool(stat.is_file());
                metadata["sizeBytes"] = Value::from(stat.len());
                if let Ok(modified) = stat.modified()
                    && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
                {
                    metadata["updatedAt"] = Value::String(
                        chrono::DateTime::from_timestamp_millis(duration.as_millis() as i64)
                            .unwrap_or_default()
                            .to_rfc3339(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                metadata["exists"] = Value::Bool(false);
                metadata["sizeBytes"] = Value::from(0);
            }
            Err(_) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal runner error.",
                );
            }
        }
    }
    json_response(StatusCode::OK, metadata)
}

async fn diagnostics_export(State(state): State<AppState>) -> Response {
    let metadata = state.store.diagnostic_metadata();
    if metadata.get("enabled").and_then(Value::as_bool) != Some(true) {
        return error_response(
            StatusCode::NOT_FOUND,
            "diagnostics_unavailable",
            "Diagnostics are not available.",
        );
    }
    let Some(path) = metadata.get("logPath").and_then(Value::as_str) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "diagnostics_unavailable",
            "Diagnostics are not available.",
        );
    };
    let Ok(bytes) = fs::read(path) else {
        return error_response(
            StatusCode::NOT_FOUND,
            "diagnostics_not_found",
            "Diagnostics log has not been created yet.",
        );
    };
    let filename = attachment_filename(Path::new(path));
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    response
}

async fn create_session(State(state): State<AppState>, request: Request) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if body.keys().any(|key| key != "contextState") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_session_seed",
            "Session creation contains an unknown field.",
        );
    }
    let context_state = match body.get("contextState") {
        None | Some(Value::Null) => None,
        Some(value) => match serde_json::from_value::<ContextStateV1>(value.clone()) {
            Ok(value) => Some(value),
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_context_state",
                    "Context state is malformed.",
                );
            }
        },
    };
    match state.store.create(context_state).await {
        Ok(session) => json_response(StatusCode::OK, json!({ "id": session.id })),
        Err(_) => error_response(
            StatusCode::BAD_REQUEST,
            "invalid_context_state",
            "Context state failed validation.",
        ),
    }
}

async fn session_context(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Ok(session) = state.store.get(&id).await else {
        return error_response(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Session not found.",
        );
    };
    let messages = session.messages.lock().await.clone();
    let summary = session.durable_summary.lock().await.clone();
    let calibration = session.context_calibration.lock().await.clone();
    let skills = session
        .config
        .skills
        .iter()
        .map(|skill| {
            json!({
                "id": skill.id,
                "name": skill.name,
                "description": skill.description,
                "source": skill.source,
            })
        })
        .collect::<Vec<_>>();
    let additional = if skills.is_empty() {
        vec![]
    } else {
        vec![Value::Array(skills)]
    };
    let estimate = estimate_context_usage(
        &messages,
        &[],
        session.config.context_length,
        session.config.max_response_tokens,
        session.config.protected_prompt_reserve_tokens,
        &additional,
    );
    let snapshot = snapshot_context_state(crate::context_state::ContextStateSnapshotInput {
        task_id: &session.task_id,
        updated_at: now_iso(),
        summary,
        messages: &messages,
        context_length: session.config.context_length,
        estimated_prompt_tokens: estimate.heuristic_prompt_tokens,
        calibration: calibration.as_ref(),
        compaction_count: session
            .compaction_count
            .load(std::sync::atomic::Ordering::SeqCst),
    });
    json_response(
        StatusCode::OK,
        serde_json::to_value(snapshot).unwrap_or(Value::Null),
    )
}

async fn prompt(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    request: Request,
) -> Response {
    let Ok(session) = state.store.get(&id).await else {
        return error_response(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Session not found.",
        );
    };
    let body = match read_json_with_limit(request, MAX_PROMPT_BODY_BYTES).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if body.contains_key("system") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "protected_system_prompt",
            "System prompts are managed by Veil.",
        );
    }
    let turn = match session.try_begin_turn() {
        Ok(turn) => turn,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "turn_in_progress",
                "A turn is already in progress for this session.",
            );
        }
    };
    let parts = input_parts(&body);
    let sink = state.store.sink.clone();
    let permissions = state.store.permissions.clone();
    let turn_id = turn.turn_id().to_owned();
    tokio::spawn(async move {
        let result = run_turn(session.clone(), parts, sink.clone(), permissions).await;
        match result {
            Ok(summary) => sink.emit(json!({
                "type":"session.idle",
                "taskId":session.task_id,
                "sessionId":session.id,
                "turnId":turn_id,
                "summary":summary,
                "at":now_iso()
            })),
            Err(error) => {
                let detail = redact_text(
                    &error.split_whitespace().collect::<Vec<_>>().join(" "),
                    1000,
                );
                let (category, code) = runner_failure_classification(&detail);
                sink.emit(json!({
                    "type":"runner.error",
                    "taskId":session.task_id,
                    "sessionId":session.id,
                    "turnId":turn_id,
                    "category":category,
                    "code":code,
                    "message":format!("Runner turn failed: {detail}"),
                    "detail":detail,
                    "at":now_iso()
                }));
            }
        }
        // Keep the busy guard until terminal events are emitted so clients never see
        // a free slot while this turn's idle/error is still in flight.
        drop(turn);
    });
    StatusCode::NO_CONTENT.into_response()
}

fn runner_failure_classification(detail: &str) -> (&'static str, &'static str) {
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("aborted") {
        return ("abort", "turn_aborted");
    }
    if normalized.contains("context window is full") {
        return ("context", "context_window_full");
    }
    if normalized.contains("model request failed") {
        return ("provider", "model_request_failed");
    }
    if normalized.contains("completion marker") || normalized.contains("model stream") {
        return ("provider", "model_stream_incomplete");
    }
    ("loop", "loop_error")
}

async fn permission_reply(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    request: Request,
) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let allow = matches!(
        body.get("reply").and_then(Value::as_str),
        Some("once" | "allow")
    ) || body.get("response").and_then(Value::as_str) == Some("once");
    let replied =
        state
            .store
            .permissions
            .reply(&state.store.sink, &id, if allow { "allow" } else { "deny" });
    json_response(
        if replied {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        },
        Value::Bool(replied),
    )
}

async fn abort(State(state): State<AppState>, AxumPath(id): AxumPath<String>) -> Response {
    match state.store.abort(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => error_response(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Session not found.",
        ),
    }
}

async fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not_found", "Not found")
}

pub async fn listen(hostname: &str, port: u16, password: String) -> Result<RunnerServer, String> {
    require_loopback(hostname)?;
    let store = SessionStore::new()?;
    let state = AppState {
        store: store.clone(),
        password: Arc::from(password),
    };
    let app = Router::new()
        .route("/event", get(events))
        .route("/diagnostics", get(diagnostics))
        .route("/diagnostics/export", get(diagnostics_export))
        .route("/session", post(create_session))
        .route("/session/{id}/context", get(session_context))
        .route("/session/{id}/prompt_async", post(prompt))
        .route("/session/{id}/abort", post(abort))
        .route("/permission/{id}/reply", post(permission_reply))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state);
    let listener = TcpListener::bind((hostname, port))
        .await
        .map_err(|error| error.to_string())?;
    let address: SocketAddr = listener.local_addr().map_err(|error| error.to_string())?;
    let url = format!("http://{hostname}:{}", address.port());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    Ok(RunnerServer {
        url,
        shutdown: Some(shutdown_tx),
        task,
        store,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorization_comparison_checks_username_and_password() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!(
                "Basic {}",
                STANDARD.encode("umbratic-runner:secret")
            ))
            .unwrap(),
        );
        assert!(authorized(&headers, "secret"));
        assert!(!authorized(&headers, "other"));
    }

    #[test]
    fn listener_only_accepts_explicit_loopback_hosts() {
        for hostname in ["127.0.0.1", "127.42.0.9", "::1"] {
            assert_eq!(require_loopback(hostname), Ok(()), "{hostname}");
        }
        for hostname in [
            "0.0.0.0",
            "::",
            "192.168.1.10",
            "localhost",
            "example.com",
            "",
        ] {
            assert!(require_loopback(hostname).is_err(), "{hostname}");
        }
    }

    #[test]
    fn diagnostic_attachment_names_cannot_inject_headers() {
        assert_eq!(
            attachment_filename(Path::new("report\"\r\nX-Injected: yes.jsonl")),
            "report___X-Injected__yes.jsonl"
        );
        let header = HeaderValue::from_str(&format!(
            "attachment; filename=\"{}\"",
            attachment_filename(Path::new("report\"\r\nX-Injected: yes.jsonl"))
        ));
        assert!(header.is_ok());
    }

    #[test]
    fn runner_failures_keep_actionable_categories() {
        assert_eq!(
            runner_failure_classification("model request failed: the model service timed out"),
            ("provider", "model_request_failed")
        );
        assert_eq!(
            runner_failure_classification("Context window is full: request needs 17000 tokens"),
            ("context", "context_window_full")
        );
        assert_eq!(
            runner_failure_classification("model stream ended before the completion marker"),
            ("provider", "model_stream_incomplete")
        );
    }
}
