use aegis_core::AegisCore;
use aegis_model::{ChatStreamEvent, LmStudioClient, ModelClient};
use aegis_protocol::{
    AddProjectParams, AgentStreamEvent, DaemonHealth, ProjectSearchParams, RpcRequest, RpcResponse,
    SendTaskParams, ServerEvent, ServiceStatus, StartupLine,
};
use aegis_store::Store;
use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::mpsc};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    token: String,
    store: Store,
    model: Arc<dyn ModelClient>,
    core: AegisCore,
    model_base_url: String,
    lm_health_cache: Arc<Mutex<Option<(Instant, ServiceStatus)>>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("aegis_app=info".parse()?))
        .with_writer(std::io::stderr)
        .init();

    let model_base_url = std::env::var("AEGIS_LM_STUDIO_URL")
        .unwrap_or_else(|_| "http://localhost:1234/v1".to_string());
    let model = Arc::new(LmStudioClient::new(model_base_url.clone(), "lm-studio"));
    let store = Store::open_default().await?;
    let core = AegisCore::new(store.clone(), model.clone());
    let token = Uuid::new_v4().to_string();
    let state = AppState {
        token: token.clone(),
        store,
        model,
        core,
        model_base_url,
        lm_health_cache: Arc::new(Mutex::new(None)),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/", get(ws_handler))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind daemon listener")?;
    let addr = listener.local_addr()?;
    let startup = StartupLine {
        url: format!("ws://{addr}"),
        token,
    };
    println!("{}", serde_json::to_string(&startup)?);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<DaemonHealth> {
    Json(build_health(&state).await)
}

#[derive(Debug, Deserialize)]
struct AuthQuery {
    token: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(auth): Query<AuthQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if auth.token != state.token {
        return Json(json!({ "error": "unauthorized" })).into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let status = ServerEvent::Status(build_health(&state).await);
    let _ = sender
        .send(Message::Text(
            serde_json::to_string(&status).unwrap_or_default(),
        ))
        .await;

    while let Some(Ok(message)) = receiver.next().await {
        let Message::Text(text) = message else {
            continue;
        };

        let response = match serde_json::from_str::<RpcRequest>(&text) {
            Ok(request) => {
                let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ServerEvent>();
                let response_future = dispatch(request, &state, Some(event_tx));
                tokio::pin!(response_future);
                loop {
                    tokio::select! {
                        response = &mut response_future => break response,
                        Some(event) = event_rx.recv() => {
                            if sender
                                .send(Message::Text(serde_json::to_string(&event).unwrap_or_default()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                }
            }
            Err(error) => RpcResponse::err("unknown", format!("invalid request: {error}")),
        };

        if sender
            .send(Message::Text(
                serde_json::to_string(&response).unwrap_or_default(),
            ))
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn dispatch(
    request: RpcRequest,
    state: &AppState,
    event_tx: Option<mpsc::UnboundedSender<ServerEvent>>,
) -> RpcResponse {
    match request.method.as_str() {
        "daemon.health" => RpcResponse::ok(request.id, build_health(state).await),
        "model.list" => match state.model.list_models().await {
            Ok(models) => RpcResponse::ok(request.id, models),
            Err(error) => RpcResponse::err(request.id, error.to_string()),
        },
        "project.add" => {
            let params = match serde_json::from_value::<AddProjectParams>(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return RpcResponse::err(request.id, format!("invalid params: {error}"))
                }
            };
            let root = PathBuf::from(&params.root_path);
            let root = match root.canonicalize() {
                Ok(root) => root,
                Err(error) => return RpcResponse::err(request.id, error.to_string()),
            };
            let name = params.name.unwrap_or_else(|| {
                root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Project")
                    .to_string()
            });
            match state
                .store
                .add_project(&root.display().to_string(), &name)
                .await
            {
                Ok(project) => RpcResponse::ok(request.id, project),
                Err(error) => RpcResponse::err(request.id, error.to_string()),
            }
        }
        "project.list" => match state.store.list_projects().await {
            Ok(projects) => RpcResponse::ok(request.id, projects),
            Err(error) => RpcResponse::err(request.id, error.to_string()),
        },
        "project.search" => {
            let params = match serde_json::from_value::<ProjectSearchParams>(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return RpcResponse::err(request.id, format!("invalid params: {error}"))
                }
            };
            match aegis_tools::lexical_search(
                &PathBuf::from(params.project_root),
                &params.query,
                params.limit,
            ) {
                Ok(matches) => RpcResponse::ok(request.id, matches),
                Err(error) => RpcResponse::err(request.id, error.to_string()),
            }
        }
        "project.files" => {
            let root = request
                .params
                .get("projectRoot")
                .or_else(|| request.params.get("project_root"))
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let limit = request
                .params
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10_000) as usize;
            match root {
                Some(root) => match aegis_tools::list_project_files(&root, limit) {
                    Ok(files) => RpcResponse::ok(request.id, files),
                    Err(error) => RpcResponse::err(request.id, error.to_string()),
                },
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "file.read" => {
            let root = request
                .params
                .get("projectRoot")
                .or_else(|| request.params.get("project_root"))
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let file = request
                .params
                .get("path")
                .or_else(|| request.params.get("file"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .trim_start_matches('@')
                .replace('\\', "/");
            match root {
                Some(root) => {
                    match aegis_tools::read_text_file(&root, &PathBuf::from(&file), 12_000) {
                        Ok(content) => RpcResponse::ok(request.id, content),
                        Err(error) => {
                            match aegis_tools::resolve_project_file_reference(&root, &file, 10_000)
                            {
                                Ok(Some(resolved)) => {
                                    match aegis_tools::read_text_file(&root, &resolved, 12_000) {
                                        Ok(content) => RpcResponse::ok(request.id, content),
                                        Err(second_error) => {
                                            RpcResponse::err(request.id, second_error.to_string())
                                        }
                                    }
                                }
                                Ok(None) => RpcResponse::err(request.id, error.to_string()),
                                Err(_) => RpcResponse::err(request.id, error.to_string()),
                            }
                        }
                    }
                }
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "session.list" => {
            let project_id = request.params.get("projectId").and_then(Value::as_str);
            match state.store.list_sessions(project_id).await {
                Ok(sessions) => RpcResponse::ok(request.id, sessions),
                Err(error) => RpcResponse::err(request.id, error.to_string()),
            }
        }
        "store.overview" => match state.store.overview().await {
            Ok(overview) => RpcResponse::ok(request.id, overview),
            Err(error) => RpcResponse::err(request.id, error.to_string()),
        },
        "agent.send_task" => {
            let params = match serde_json::from_value::<SendTaskParams>(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return RpcResponse::err(request.id, format!("invalid params: {error}"))
                }
            };
            let stream_sink = event_tx.map(|event_tx| {
                let pending_turn_id = request.id.clone();
                std::sync::Arc::new(move |event: ChatStreamEvent| {
                    let _ = event_tx.send(ServerEvent::AgentStream(AgentStreamEvent {
                        turn_id: pending_turn_id.clone(),
                        kind: event.kind,
                        content: event.content,
                        data: event.data,
                    }));
                }) as aegis_model::ChatStreamSink
            });
            match state.core.send_task(params, stream_sink).await {
                Ok(result) => RpcResponse::ok(request.id, result),
                Err(error) => RpcResponse::err(request.id, error.to_string()),
            }
        }
        "ide.detect" => RpcResponse::ok(request.id, aegis_tools::detect_ides()),
        "ide.open_project" => {
            let ide_id = request.params.get("ideId").and_then(Value::as_str);
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            match (ide_id, root) {
                (Some(ide_id), Some(root)) => {
                    let installs = aegis_tools::detect_ides();
                    let Some(install) = installs.into_iter().find(|install| install.id == ide_id)
                    else {
                        return RpcResponse::err(
                            request.id,
                            format!("{ide_id} is not installed or not on PATH"),
                        );
                    };
                    match aegis_tools::open_project(&install.command, &root).await {
                        Ok(()) => RpcResponse::ok(request.id, json!({ "opened": true })),
                        Err(error) => RpcResponse::err(request.id, error.to_string()),
                    }
                }
                _ => RpcResponse::err(request.id, "ideId and projectRoot are required"),
            }
        }
        "ide.open_file" => {
            let ide_id = request.params.get("ideId").and_then(Value::as_str);
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let file = request
                .params
                .get("file")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let line = request
                .params
                .get("line")
                .and_then(Value::as_u64)
                .map(|line| line as u32);
            match (ide_id, root, file) {
                (Some(ide_id), Some(root), Some(file)) => {
                    let installs = aegis_tools::detect_ides();
                    let Some(install) = installs.into_iter().find(|install| install.id == ide_id)
                    else {
                        return RpcResponse::err(
                            request.id,
                            format!("{ide_id} is not installed or not on PATH"),
                        );
                    };
                    match aegis_tools::open_file(ide_id, &install.command, &root, &file, line).await
                    {
                        Ok(()) => RpcResponse::ok(request.id, json!({ "opened": true })),
                        Err(error) => RpcResponse::err(request.id, error.to_string()),
                    }
                }
                _ => RpcResponse::err(request.id, "ideId, projectRoot, and file are required"),
            }
        }
        "git.status" => {
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            match root {
                Some(root) => match aegis_tools::git_status(&root).await {
                    Ok(status) => RpcResponse::ok(request.id, status),
                    Err(error) => RpcResponse::err(request.id, error.to_string()),
                },
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "git.diff" => {
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            match root {
                Some(root) => match aegis_tools::git_diff(&root).await {
                    Ok(status) => RpcResponse::ok(request.id, status),
                    Err(error) => RpcResponse::err(request.id, error.to_string()),
                },
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "git.branches" => {
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            match root {
                Some(root) => match aegis_tools::git_branches(&root).await {
                    Ok(branches) => RpcResponse::ok(request.id, branches),
                    Err(error) => RpcResponse::err(request.id, error.to_string()),
                },
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "git.worktree_list" => {
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            match root {
                Some(root) => match aegis_tools::git_worktrees(&root).await {
                    Ok(worktrees) => RpcResponse::ok(request.id, worktrees),
                    Err(error) => RpcResponse::err(request.id, error.to_string()),
                },
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        "git.worktree_create" => {
            let root = request
                .params
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let branch = request
                .params
                .get("branch")
                .and_then(Value::as_str)
                .unwrap_or("HEAD");
            let new_branch = request
                .params
                .get("newBranch")
                .and_then(Value::as_str)
                .unwrap_or("codex/aegis-worktree");
            let worktree_name = request.params.get("worktreeName").and_then(Value::as_str);
            match root {
                Some(root) => {
                    match aegis_tools::git_create_worktree(&root, branch, new_branch, worktree_name)
                        .await
                    {
                        Ok(worktree) => RpcResponse::ok(request.id, worktree),
                        Err(error) => RpcResponse::err(request.id, error.to_string()),
                    }
                }
                None => RpcResponse::err(request.id, "projectRoot is required"),
            }
        }
        _ => RpcResponse::err(request.id, format!("unknown method {}", request.method)),
    }
}

async fn build_health(state: &AppState) -> DaemonHealth {
    let lm_studio = cached_lm_studio_status(state).await;

    DaemonHealth {
        daemon: ServiceStatus::Ready,
        sqlite_path: state.store.db_path().display().to_string(),
        lm_studio,
        model_base_url: state.model_base_url.clone(),
        semantic_index: ServiceStatus::Degraded,
    }
}

async fn cached_lm_studio_status(state: &AppState) -> ServiceStatus {
    if let Ok(cache) = state.lm_health_cache.lock() {
        if let Some((at, status)) = &*cache {
            if at.elapsed() < Duration::from_secs(10) {
                return status.clone();
            }
        }
    }

    let status = match state.model.list_models().await {
        Ok(_) => ServiceStatus::Ready,
        Err(_) => ServiceStatus::Unavailable,
    };

    if let Ok(mut cache) = state.lm_health_cache.lock() {
        *cache = Some((Instant::now(), status.clone()));
    }
    status
}
