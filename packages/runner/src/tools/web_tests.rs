use std::sync::Arc;

use serde_json::json;

use super::{
    ToolCall, execute_tool,
    web::{check_public_url, parse_ddg_html, readable_text, set_test_http, truncate_page},
};

const DDG_HTML: &str = r#"
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
  <a class="result__snippet">Official documentation for the example protocol.</a>
</div>
<div class="result">
  <a class="result__a" href="https://news.example.org/story">A story</a>
  <a class="result__snippet">What happened today.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%2Fsecret">Local</a>
  <a class="result__snippet">Should be dropped.</a>
</div>
"#;

#[test]
fn ddg_html_decodes_uddg_and_drops_private_hits() {
    let hits = parse_ddg_html(DDG_HTML);
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].title, "Example Docs");
    assert_eq!(hits[0].url, "https://example.com/docs");
    assert!(hits[0].snippet.contains("Official documentation"));
    assert_eq!(hits[1].url, "https://news.example.org/story");
}

#[test]
fn readable_text_strips_scripts_and_collapses_space() {
    let text = readable_text(
        "<html><script>alert(1)</script><h1>Hello</h1><p>world &amp; friends</p></html>",
    );
    assert_eq!(text, "Hello world & friends");
    assert!(!text.contains("alert"));
    assert_eq!(
        readable_text("Chiba&#x27;s deluge and Israel&#8217;s assault"),
        "Chiba's deluge and Israel\u{2019}s assault",
    );
    // Whole elements go, in one pass, whatever their case or attributes; a tag
    // that merely starts with the name is not the element.
    assert_eq!(
        readable_text(
            "<p>a</p><SCRIPT type=\"x\">1<2</ScRiPt ><style>b{}</style><scripts>keep</scripts><p>z</p>",
        ),
        "a keep z"
    );
    // An element that never closes swallows the rest, as it would in a browser.
    assert_eq!(readable_text("<p>seen</p><script>never closed"), "seen");
    // Nothing is copied from the lowercased shadow: the original case survives.
    assert_eq!(
        readable_text("<noscript>X</noscript><h1>Big Title</h1>"),
        "Big Title"
    );
}

#[test]
fn a_long_page_is_cut_with_a_note_rather_than_refused() {
    let page = "word ".repeat(40_000);
    let text = truncate_page(&page);
    assert!(text.chars().count() < page.chars().count());
    assert!(text.ends_with(&format!(
        "... (truncated: showing 100000 of {} characters)",
        page.chars().count()
    )));
    // Under the budget it comes back untouched.
    assert_eq!(truncate_page("short"), "short");
    assert_eq!(truncate_page(""), "(page returned no readable text)");
}

#[test]
fn public_url_policy_blocks_private_and_credentialed_targets() {
    assert!(check_public_url("https://example.com/a").is_ok());
    assert!(check_public_url("http://127.0.0.1/").is_err());
    assert!(check_public_url("http://10.0.0.4/").is_err());
    assert!(check_public_url("http://169.254.169.254/latest").is_err());
    assert!(check_public_url("http://localhost/").is_err());
    assert!(check_public_url("https://user:pass@example.com/").is_err());
    assert!(check_public_url("file:///etc/passwd").is_err());
    assert!(check_public_url("not-a-url").is_err());
}

#[tokio::test]
async fn web_search_formats_stubbed_ddg_results() {
    let _http = set_test_http(Box::new(|method, url| {
        assert_eq!(method, "POST");
        assert!(url.contains("duckduckgo.com"));
        Ok(DDG_HTML.to_owned())
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "search-1".into(),
            name: "web_search".into(),
            arguments: json!({ "query": "example protocol" }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert!(result.content.contains("https://example.com/docs"));
    assert!(result.content.contains("web_fetch"));
    assert!(!result.content.contains("127.0.0.1"));
}

#[tokio::test]
async fn web_fetch_returns_readable_text_from_the_stub() {
    let _http = set_test_http(Box::new(|method, url| {
        assert_eq!(method, "GET");
        assert_eq!(url, "https://example.com/docs");
        Ok("<html><h1>Docs</h1><p>Use the protocol.</p></html>".to_owned())
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "fetch-1".into(),
            name: "web_fetch".into(),
            arguments: json!({ "url": "https://example.com/docs" }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert_eq!(result.content, "Docs Use the protocol.");
}

#[tokio::test]
async fn web_fetch_blocks_loopback_before_any_request() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("loopback fetch must not reach HTTP");
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "fetch-blocked".into(),
            name: "web_fetch".into(),
            arguments: json!({ "url": "http://127.0.0.1/secret" }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "policy_blocked");
    assert!(result.error_message.unwrap().contains("Blocked"));
}

#[tokio::test]
async fn web_tools_are_absent_when_the_capability_is_off() {
    let directory = tempfile::tempdir().unwrap();
    let mut session = crate::session::test_session(directory.path());
    Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config)
        .unwrap()
        .enabled_tools
        .retain(|name| name != "web_search" && name != "web_fetch");
    let result = execute_tool(
        session,
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "search-off".into(),
            name: "web_search".into(),
            arguments: json!({ "query": "x" }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "validation_error");
    assert_eq!(result.code.as_deref(), Some("tool_disabled"));
}
