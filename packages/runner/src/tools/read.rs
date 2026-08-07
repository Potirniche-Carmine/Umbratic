use std::io::{BufRead, BufReader};

use serde_json::json;
use umbratic_pdf::{InspectError, InspectOptions, PdfType, inspect_file};

use super::catalog::{DEFAULT_READ_LINES, DEFAULT_READ_RADIUS};
use super::*;

/// The line range a read should cover, resolved from already-validated input.
///
/// `line` centres `radius` lines on one line; otherwise `offset` and `limit`
/// page through the file. A call that sets neither still gets a bound, so the
/// cheapest thing to type is no longer a whole-file read.
fn read_window(input: &Map<String, Value>) -> (usize, usize) {
    let Some(line) = input.get("line").and_then(Value::as_u64) else {
        let offset = number_arg(input, "offset", 1).max(1);
        return (
            offset as usize,
            number_arg(input, "limit", DEFAULT_READ_LINES as u64) as usize,
        );
    };
    let radius = number_arg(input, "radius", DEFAULT_READ_RADIUS as u64);
    let offset = line.saturating_sub(radius).max(1);
    // Measured from `line` rather than from `offset`, so a window centred near
    // the top of a file keeps its full reach below `line` after clamping. The
    // result cannot exceed 2 * radius + 1, which the declared radius bound
    // already holds under the flat line cap.
    let limit = line + radius - offset + 1;
    (offset as usize, limit as usize)
}

/// The model-facing coordinates for a read. Reported for every read, not only
/// truncated ones: a window is unusable without knowing where it sits.
fn read_location(relative: &str, shown_start: usize, shown_end: usize, total: usize) -> String {
    if shown_start == 0 {
        return format!("{relative}: no lines in range; the file has {total} lines.");
    }
    format!("{relative} lines {shown_start}-{shown_end} of {total}.")
}

/// True when the path both claims to be and actually starts like a PDF, so
/// misnamed binaries still hit the regular binary refusal.
fn is_pdf_file(path: &Path) -> bool {
    let claims_pdf = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if !claims_pdf {
        return false;
    }
    let mut header = [0u8; 5];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map(|_| &header == b"%PDF-")
        .unwrap_or(false)
}

fn pdf_type_label(pdf_type: PdfType) -> &'static str {
    match pdf_type {
        PdfType::TextBased => "text_based",
        PdfType::Scanned => "scanned",
        PdfType::ImageBased => "image_based",
        PdfType::Mixed => "mixed",
    }
}

/// Extracts the native-text Markdown for a PDF, failing closed for documents
/// without a usable text layer instead of returning silent empty text.
fn pdf_markdown(path: &Path, label: &str) -> Result<(umbratic_pdf::Inspection, String), ToolError> {
    let options = InspectOptions {
        extract: true,
        ..InspectOptions::default()
    };
    let inspection = inspect_file(path, &options).map_err(|error| match error {
        InspectError::TooLarge { .. } => ToolError::validation(error.to_string()),
        other => ToolError::validation_code("pdf_unreadable", format!("{label}: {other}")),
    })?;
    if matches!(inspection.pdf_type, PdfType::Scanned | PdfType::ImageBased) {
        return Err(ToolError::validation_code(
            "pdf_needs_ocr",
            format!(
                "{label} is a {} PDF ({} page{}) without a machine-readable text layer. Rasterize the pages or use OCR instead of reading it as text.",
                pdf_type_label(inspection.pdf_type),
                inspection.page_count,
                if inspection.page_count == 1 { "" } else { "s" },
            ),
        ));
    }
    let markdown = inspection.markdown.clone().unwrap_or_default();
    if markdown.trim().is_empty() {
        return Err(ToolError::validation_code(
            "pdf_unreadable",
            format!("{label}: no text could be extracted from the PDF."),
        ));
    }
    Ok((inspection, markdown))
}

fn pdf_header_lines(inspection: &umbratic_pdf::Inspection, label: &str) -> String {
    let mut header = format!(
        "PDF {label}: {}, {} page{}; native text extract shown below.",
        pdf_type_label(inspection.pdf_type),
        inspection.page_count,
        if inspection.page_count == 1 { "" } else { "s" },
    );
    if !inspection.pages_needing_ocr.is_empty() {
        header.push_str(&format!(
            "\nPages without a text layer (need vision/OCR): {:?}.",
            inspection.pages_needing_ocr
        ));
    }
    if inspection.has_encoding_issues {
        header.push_str(
            "\nWarning: the text layer shows encoding issues; verify important values visually.",
        );
    }
    header
}

/// Serves the extracted Markdown with the same offset/limit line semantics as
/// the plain-text `read` path.
fn read_pdf_tool(
    absolute: &Path,
    relative: &str,
    offset: usize,
    line_limit: usize,
) -> ToolExecutionResult {
    let (inspection, markdown) = pdf_markdown(absolute, relative)?;
    let lines: Vec<&str> = markdown.lines().collect();
    let total_lines = lines.len();
    let mut selected: Vec<&str> = Vec::new();
    let mut selected_bytes = 0usize;
    for line in lines.iter().skip(offset.saturating_sub(1)) {
        if selected.len() >= line_limit {
            break;
        }
        let joiner = usize::from(!selected.is_empty());
        if selected_bytes + line.len() + joiner > MAX_READ_OUTPUT_BYTES {
            break;
        }
        selected_bytes += line.len() + joiner;
        selected.push(line);
    }
    let shown_start = if selected.is_empty() { 0 } else { offset };
    let shown_end = if selected.is_empty() {
        0
    } else {
        offset + selected.len() - 1
    };
    let next_offset = if shown_end > 0 && shown_end < total_lines {
        Some(shown_end + 1)
    } else {
        None
    };
    let content = format!(
        "{}\n\n{}",
        pdf_header_lines(&inspection, relative),
        selected.join("\n")
    );
    let details = json!({
        "path": relative,
        "pdfType": pdf_type_label(inspection.pdf_type),
        "pageCount": inspection.page_count,
        "hasEncodingIssues": inspection.has_encoding_issues,
        "offset": offset,
        "shownStart": shown_start,
        "shownEnd": shown_end,
        "totalLines": total_lines,
    });
    let continuation = next_offset.map(|value| json!({ "nextOffset": value }));
    let location = read_location(relative, shown_start, shown_end, total_lines);
    Ok(
        ToolResult::success_detailed(relative.to_owned(), content, Some(details), continuation)
            .at(location),
    )
}

fn missing_path_message(cwd: &Path, absolute: &Path, relative: &str) -> String {
    let workspace_root = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut directory = absolute.parent().unwrap_or(&workspace_root);
    while !directory.is_dir() && directory.starts_with(&workspace_root) {
        directory = directory.parent().unwrap_or(&workspace_root);
    }
    let base = directory
        .strip_prefix(&workspace_root)
        .unwrap_or(directory)
        .to_string_lossy()
        .replace('\\', "/");
    let nearby = list_entries(directory)
        .into_iter()
        .take(12)
        .map(|entry| {
            if base.is_empty() {
                entry
            } else {
                format!("{base}/{entry}")
            }
        })
        .collect::<Vec<_>>();
    let guidance = if nearby.is_empty() {
        "Use ls or find to locate an existing workspace path.".to_owned()
    } else {
        format!(
            "Nearby workspace entries:\n- {}\nUse an exact listed path, or use search or find with a broader scope.",
            nearby.join("\n- ")
        )
    };
    format!("Path not found: {relative}.\n{guidance}")
}

pub(super) fn list_entries(directory: &Path) -> Vec<String> {
    let mut rows = BTreeSet::new();
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().replace('\\', "/");
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|value| value.is_dir())
            .unwrap_or(false);
        rows.insert(format!("{name}{}", if is_dir { "/" } else { "" }));
    }
    rows.into_iter().collect()
}

fn decode_text_line(buffer: &[u8], line_number: usize) -> Result<String, ToolError> {
    if buffer.contains(&0) {
        return Err(ToolError::validation("Refusing to read binary file"));
    }
    if buffer.len() > MAX_READ_OUTPUT_BYTES {
        return Err(ToolError::validation_code(
            "line_too_long",
            format!(
                "Line {line_number} is {} bytes and exceeds the {MAX_READ_OUTPUT_BYTES}-byte line cap.",
                buffer.len()
            ),
        ));
    }
    String::from_utf8(buffer.to_vec())
        .map_err(|_| ToolError::validation("Refusing to read non-UTF-8 file"))
}

pub(super) async fn read_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    if path.is_empty() {
        return Err("read requires string argument path".into());
    }
    let (offset, line_limit) = read_window(input);
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::validation(missing_path_message(
                &session.config.cwd,
                &absolute,
                &relative,
            )));
        }
        Err(error) => return Err(ToolError::runtime(error.to_string())),
    };
    if metadata.is_dir() {
        return Err(ToolError::validation(
            "read accepts one UTF-8 text file. Use ls to list a directory.",
        ));
    }
    if !metadata.is_file() {
        return Err(ToolError::validation("Path is not a file"));
    }
    if is_pdf_file(&absolute) {
        return read_pdf_tool(&absolute, &relative, offset, line_limit);
    }
    let file = fs::File::open(&absolute).map_err(|error| ToolError::runtime(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut total_lines = 0usize;
    let mut selected = Vec::new();
    let mut selected_bytes = 0usize;
    let mut collecting = true;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| ToolError::runtime(error.to_string()))?;
        if read == 0 {
            break;
        }
        // The terminator is carried with its line so that read output is a byte-exact
        // slice of the file on every line-ending style. edit matches raw bytes, so
        // normalizing here would break a verbatim copy into edits[].oldText.
        let mut terminator = "";
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
                terminator = "\r\n";
            } else {
                terminator = "\n";
            }
        }
        total_lines += 1;
        let line = decode_text_line(&buffer, total_lines)?;
        if !collecting || total_lines < offset {
            continue;
        }
        if selected.len() >= line_limit {
            collecting = false;
            continue;
        }
        let joiner = selected
            .last()
            .map_or(0, |(_, previous): &(String, &str)| previous.len());
        let next_bytes = selected_bytes + line.len() + joiner;
        if next_bytes > MAX_READ_OUTPUT_BYTES {
            if selected.is_empty() {
                return Err(ToolError::validation_code(
                    "line_too_long",
                    format!(
                        "Line {total_lines} is {} bytes and exceeds the remaining output budget.",
                        line.len()
                    ),
                ));
            }
            collecting = false;
            continue;
        }
        selected_bytes = next_bytes;
        selected.push((line, terminator));
    }
    let shown_start = if selected.is_empty() { 0 } else { offset };
    let shown_end = if selected.is_empty() {
        0
    } else {
        offset + selected.len() - 1
    };
    let next_offset = if shown_end > 0 && shown_end < total_lines {
        Some(shown_end + 1)
    } else {
        None
    };
    // Each line keeps its own terminator; the final terminator is left off so the
    // result stays an exact substring of the file even at an unterminated last line.
    let mut content = String::with_capacity(selected_bytes);
    for (index, (line, _)) in selected.iter().enumerate() {
        if index > 0 {
            content.push_str(selected[index - 1].1);
        }
        content.push_str(line);
    }
    let details = json!({
        "path": if relative.is_empty() { "." } else { &relative },
        "offset": offset,
        "shownStart": shown_start,
        "shownEnd": shown_end,
        "totalLines": total_lines,
        "bytes": content.len(),
    });
    let continuation = next_offset.map(|value| json!({ "nextOffset": value }));
    let location = read_location(&relative, shown_start, shown_end, total_lines);
    Ok(ToolResult::success_detailed(relative, content, Some(details), continuation).at(location))
}

/// Serves the extracted Markdown of a PDF attachment through the same byte
/// offset/limit window as plain-text attachments; offsets index the extract.
fn read_pdf_attachment(
    attachment_id: &str,
    canonical: &Path,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let label = format!("Attachment {attachment_id}");
    let (inspection, markdown) = pdf_markdown(canonical, &label)?;
    let total = markdown.len();
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
    let mut start = requested_offset;
    while !markdown.is_char_boundary(start) {
        start += 1;
    }
    let mut end = (start + limit).min(total);
    while !markdown.is_char_boundary(end) {
        end -= 1;
    }
    let chunk = &markdown[start..end];
    let next_offset = start + chunk.len();
    let continuation = (next_offset < total).then(|| json!({ "nextOffset": next_offset }));
    let status = if continuation.is_some() {
        format!("partial; continue with offset {next_offset}")
    } else {
        "complete".to_owned()
    };
    Ok(ToolResult::success_detailed(
        format!("attachment {attachment_id}"),
        format!(
            "Attachment: {attachment_id}\n{}\nBytes shown: {start}-{next_offset} of {total} (of the extracted Markdown)\nRead status: {status}\n\n{chunk}",
            pdf_header_lines(&inspection, &label),
        ),
        Some(json!({
            "attachmentId": attachment_id,
            "pdfType": pdf_type_label(inspection.pdf_type),
            "pageCount": inspection.page_count,
            "hasEncodingIssues": inspection.has_encoding_issues,
            "offset": start,
            "nextOffset": if next_offset < total { Value::from(next_offset as u64) } else { Value::Null },
            "totalBytes": total,
        })),
        continuation,
    ))
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
    if is_pdf_file(&canonical) {
        return read_pdf_attachment(&attachment_id, &canonical, input);
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
    let continuation = if next_offset < total {
        Some(json!({ "nextOffset": next_offset }))
    } else {
        None
    };
    let status = if continuation.is_some() {
        format!("partial; continue with offset {next_offset}")
    } else {
        "complete".to_owned()
    };
    Ok(ToolResult::success_detailed(
        format!("attachment {attachment_id}"),
        format!(
            "Attachment: {attachment_id}\nBytes shown: {actual_offset}-{next_offset} of {total}\nRead status: {status}\n\n{content}"
        ),
        Some(json!({
            "attachmentId": attachment_id,
            "offset": actual_offset,
            "nextOffset": if next_offset < total { Value::from(next_offset as u64) } else { Value::Null },
            "totalBytes": total,
        })),
        continuation,
    ))
}
