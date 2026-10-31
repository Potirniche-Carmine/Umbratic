use super::*;
use std::io::Write;
use std::time::Duration;

pub(super) async fn generate_image_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    let prompt = string_arg(input, &["prompt"]);
    let width = number_arg(input, "width", 512);
    let height = number_arg(input, "height", 512);
    if prompt.trim().is_empty()
        || prompt.len() > 8000
        || !width.is_multiple_of(32)
        || !height.is_multiple_of(32)
    {
        return Err(ToolError::validation(
            "Use a prompt of at most 8000 bytes and dimensions divisible by 32.",
        ));
    }
    if !path.to_lowercase().ends_with(".png") || Path::new(&path).is_absolute() {
        return Err(ToolError::validation(
            "Use a new workspace-relative .png path.",
        ));
    }
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    if absolute.exists() {
        return Err(ToolError::validation(
            "That output already exists. Choose a new image filename.",
        ));
    }
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("generate image {relative}"),
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision == "abort" {
        return Err(ToolError::aborted("Image generation cancelled."));
    }
    if decision != "allow" {
        return Err(ToolError::permission(
            "Image generation was declined. Do not retry without a new user request.",
        ));
    }
    let generation = crate::veil_client::generate_image(session, &prompt, width, height);
    tokio::pin!(generation);
    let bytes = loop {
        tokio::select! {
            result = &mut generation => break result.map_err(ToolError::runtime)?,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if session.is_aborted() { return Err(ToolError::aborted("Image generation cancelled.")); }
            }
        }
    };
    if session.is_aborted() {
        return Err(ToolError::aborted("Image generation cancelled."));
    }
    let target =
        confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    let parent = target
        .parent()
        .ok_or_else(|| ToolError::policy("Image output has no parent."))?;
    fs::create_dir_all(parent)
        .map_err(|_| ToolError::runtime("Could not create the image folder."))?;
    let target =
        confirm_workspace_write_path(&session.config.cwd, &target).map_err(ToolError::policy)?;
    let staged = parent.join(format!(".umbratic-image-{}.png", uuid::Uuid::new_v4()));
    let saved = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Atomic installation without replacing an existing file, even if it
        // appeared during generation. Both names are in the same directory.
        fs::hard_link(&staged, &target)
    })();
    let _ = fs::remove_file(&staged);
    saved.map_err(|_| {
        ToolError::runtime("Could not save the image. Choose a new output filename.")
    })?;
    Ok(ToolResult::success_detailed(
        relative.clone(),
        format!(
            "Generated {width}×{height} PNG: {relative}. The image is displayed in the conversation."
        ),
        Some(
            json!({"path":relative,"image":true,"width":width,"height":height,"bytes":bytes.len()}),
        ),
        None,
    ))
}
