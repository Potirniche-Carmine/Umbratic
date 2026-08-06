use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
#[tokio::test]
async fn read_returns_pdf_markdown_with_line_paging() {
    let directory = tempfile::tempdir().unwrap();
    let paragraph = "Native inspector test document.\nIt carries enough embedded text to classify as text based.";
    std::fs::write(
        directory.path().join("report.pdf"),
        umbratic_pdf::fixtures::build_pdf(&[
            umbratic_pdf::fixtures::FixturePage::Text(paragraph),
            umbratic_pdf::fixtures::FixturePage::Text(paragraph),
        ]),
    )
    .unwrap();
    let session = crate::session::test_session(directory.path());

    let read = read_tool(&session, json!({"path":"report.pdf"}).as_object().unwrap())
        .await
        .unwrap();
    assert!(read.content.contains("PDF report.pdf: text_based, 2 pages"));
    assert!(read.content.contains("Native inspector test document."));
    assert!(read.content.contains("--- Page 2 ---"));
    assert_eq!(read.details.as_ref().unwrap()["pdfType"], "text_based");

    let paged = read_tool(
        &session,
        json!({"path":"report.pdf","offset":1,"limit":2})
            .as_object()
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(paged.content.contains("--- Page 1 ---"));
    assert!(!paged.content.contains("--- Page 2 ---"));
    assert_eq!(
        paged
            .continuation
            .as_ref()
            .and_then(|value| value.get("nextOffset"))
            .and_then(Value::as_u64),
        Some(3)
    );
}

#[tokio::test]
async fn read_refuses_scanned_pdfs_and_other_binaries() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("scan.pdf"),
        umbratic_pdf::fixtures::build_pdf(&[umbratic_pdf::fixtures::FixturePage::Images(1)]),
    )
    .unwrap();
    std::fs::write(directory.path().join("blob.bin"), b"binary\0payload").unwrap();
    std::fs::write(directory.path().join("fake.pdf"), b"binary\0payload").unwrap();
    let session = crate::session::test_session(directory.path());

    let scanned = read_tool(&session, json!({"path":"scan.pdf"}).as_object().unwrap())
        .await
        .unwrap_err();
    assert_eq!(scanned.code, "pdf_needs_ocr");
    assert!(scanned.message.contains("scanned"));

    let binary = read_tool(&session, json!({"path":"blob.bin"}).as_object().unwrap())
        .await
        .unwrap_err();
    assert!(binary.message.contains("Refusing to read binary file"));

    let fake = read_tool(&session, json!({"path":"fake.pdf"}).as_object().unwrap())
        .await
        .unwrap_err();
    assert!(fake.message.contains("Refusing to read binary file"));
}

#[tokio::test]
async fn attachment_reader_serves_pdf_markdown_in_bounded_chunks() {
    let workspace = tempfile::tempdir().unwrap();
    let attachments = tempfile::tempdir().unwrap();
    let paragraph = format!(
        "Attachment extract check for the native inspector.\n{}",
        "A steadily repeating body line that pads the extract. ".repeat(40)
    );
    std::fs::write(
        attachments.path().join("brief.pdf"),
        umbratic_pdf::fixtures::build_pdf(&[umbratic_pdf::fixtures::FixturePage::Text(&paragraph)]),
    )
    .unwrap();
    std::fs::write(
        attachments.path().join("scan.pdf"),
        umbratic_pdf::fixtures::build_pdf(&[umbratic_pdf::fixtures::FixturePage::Images(1)]),
    )
    .unwrap();
    let mut config = (*crate::session::test_config(workspace.path())).clone();
    config.attachment_directory = Some(attachments.path().to_path_buf());
    let session = Session {
        id: "session".into(),
        task_id: "task".into(),
        config: Arc::new(config),
        messages: tokio::sync::Mutex::new(Vec::new()),
        durable_summary: tokio::sync::Mutex::new(None),
        failed_compaction_digest: tokio::sync::Mutex::new(None),
        compaction_count: std::sync::atomic::AtomicU32::new(0),
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
    };

    let mut offset = 0usize;
    let mut reconstructed = String::new();
    loop {
        let args = json!({"attachmentId":"brief.pdf","offset":offset,"limit":64})
            .as_object()
            .unwrap()
            .clone();
        let result = read_attachment_tool(&session, &args).unwrap();
        assert!(result.content.contains("text_based"));
        let (_, chunk) = result.content.split_once("\n\n").unwrap();
        reconstructed.push_str(chunk);
        let Some(next) = result
            .content
            .lines()
            .find_map(|line| line.strip_prefix("Read status: partial; continue with offset "))
        else {
            assert!(result.content.contains("Read status: complete"));
            break;
        };
        offset = next.parse::<usize>().unwrap();
    }
    assert!(reconstructed.contains("Attachment extract check for the native inspector."));
    assert!(reconstructed.contains("--- Page 1 ---"));

    let scanned_args = json!({"attachmentId":"scan.pdf"})
        .as_object()
        .unwrap()
        .clone();
    let scanned = read_attachment_tool(&session, &scanned_args).unwrap_err();
    assert_eq!(scanned.code, "pdf_needs_ocr");
}
