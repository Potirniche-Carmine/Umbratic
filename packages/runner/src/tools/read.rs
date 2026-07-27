use super::*;

fn list_directory(cwd: &Path, directory: &Path, depth: usize) -> Vec<String> {
    let mut rows = BTreeSet::new();
    for entry in WalkDir::new(directory)
        .min_depth(1)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative_workspace = entry
            .path()
            .strip_prefix(cwd)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if should_skip(&relative_workspace) {
            continue;
        }
        let display = entry
            .path()
            .strip_prefix(directory)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        rows.insert(format!(
            "{display}{}",
            if entry.file_type().is_dir() { "/" } else { "" }
        ));
    }
    rows.into_iter().collect()
}

pub(super) async fn read_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let mut file_path = string_arg(input, &["filePath", "file_path", "path", "directory"]);
    if file_path.is_empty() {
        return Err("read requires string argument filePath".into());
    }
    let explicit_offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    let mut offset = explicit_offset.unwrap_or(1) as usize;
    if explicit_offset.is_none()
        && let Some((path, line)) = file_path
            .rsplit_once(':')
            .and_then(|(path, suffix)| suffix.parse::<usize>().ok().map(|line| (path, line)))
        && resolve_workspace_path(&session.config.cwd, path)
            .ok()
            .is_some_and(|(target, _)| target.is_file())
    {
        file_path = path.to_owned();
        offset = line.saturating_sub(5).max(1);
    }
    let limit = number_arg(input, "limit", 500, 500) as usize;
    let depth = number_arg(input, "depth", 1, 6) as usize;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &file_path).map_err(ToolError::policy)?;
    let metadata = fs::metadata(&absolute).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        let entries = list_directory(&session.config.cwd, &absolute, depth);
        let start = offset.saturating_sub(1).min(entries.len());
        let selected = &entries[start..(start + limit).min(entries.len())];
        let next = start + selected.len();
        let status = if next < entries.len() {
            format!("partial; continue with offset {}", next + 1)
        } else {
            "complete".into()
        };
        let output = format!(
            "Directory: {}\nDepth: {depth}\nEntries shown: {}-{} of {}\nListing status: {status}\nEntries:\n{}",
            if relative.is_empty() { "." } else { &relative },
            if entries.is_empty() { 0 } else { start + 1 },
            next,
            entries.len(),
            if selected.is_empty() {
                "(empty directory)".into()
            } else {
                selected.join("\n")
            }
        );
        return Ok(ToolResult::success(
            if relative.is_empty() { "." } else { &relative },
            clip_read_output(output),
        ));
    }
    let content = ensure_text_file(&absolute)?.replace("\r\n", "\n");
    let mut reads = RECENT_READS.get_or_init(Default::default).lock().unwrap();
    *reads.entry(absolute.clone()).or_default() += 1;
    drop(reads);
    let output = content
        .split('\n')
        .skip(offset.saturating_sub(1))
        .take(limit)
        .enumerate()
        .map(|(index, line)| format!("{}: {line}", offset + index))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolResult::success(relative, clip_read_output(output)))
}

pub(super) fn read_attachment_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let attachment_id = string_arg(input, &["attachmentId"]);
    if attachment_id.is_empty()
        || attachment_id == "."
        || attachment_id == ".."
        || attachment_id.contains('/')
        || attachment_id.contains('\\')
    {
        return Err("read_attachment requires a valid attachmentId".into());
    }
    let configured = session
        .config
        .attachment_directory
        .as_ref()
        .ok_or_else(|| "No chat attachment directory is configured for this session.".to_owned())?;
    let root = configured
        .canonicalize()
        .map_err(|_| "Chat attachment directory is unavailable.".to_owned())?;
    let target = root.join(&attachment_id);
    let canonical = target
        .canonicalize()
        .map_err(|_| format!("Attachment {attachment_id} is unavailable."))?;
    if !canonical.starts_with(&root) || canonical.parent() != Some(root.as_path()) {
        return Err("Refusing attachment path outside the current chat.".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Attachment is not a file.".into());
    }
    let total = metadata.len() as usize;
    let requested_offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(total as u64) as usize;
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_ATTACHMENT_CHUNK_BYTES as u64)
        .clamp(1, MAX_ATTACHMENT_CHUNK_BYTES as u64) as usize;
    let mut file = fs::File::open(&canonical).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(requested_offset as u64))
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0u8; limit.saturating_add(4)];
    let read = file.read(&mut bytes).map_err(|error| error.to_string())?;
    bytes.truncate(read);
    let mut leading = 0usize;
    while leading < bytes.len() && bytes[leading] & 0b1100_0000 == 0b1000_0000 {
        leading += 1;
    }
    let actual_offset = requested_offset + leading;
    let mut end = leading + limit.min(bytes.len().saturating_sub(leading));
    if let Err(error) = std::str::from_utf8(&bytes[leading..end]) {
        if error.error_len().is_some() {
            return Err("Refusing to read a non-UTF-8 attachment.".into());
        }
        end = leading + error.valid_up_to();
    }
    if bytes[leading..end].contains(&0) {
        return Err("Refusing to read a binary attachment.".into());
    }
    let content = std::str::from_utf8(&bytes[leading..end])
        .map_err(|_| "Refusing to read a non-UTF-8 attachment.".to_owned())?;
    let next_offset = actual_offset + content.len();
    let status = if next_offset < total {
        format!("partial; continue with offset {next_offset}")
    } else {
        "complete".to_owned()
    };
    Ok(ToolResult::success(
        format!("attachment {attachment_id}"),
        format!(
            "Attachment: {attachment_id}\nBytes shown: {actual_offset}-{next_offset} of {total}\nRead status: {status}\n\n{content}"
        ),
    ))
}
