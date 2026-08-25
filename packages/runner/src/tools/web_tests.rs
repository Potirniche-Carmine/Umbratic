use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    ToolCall, ToolResult, execute_tool,
    web::{
        check_public_url, is_search_results_page, parse_ddg_html, readable_text, set_test_http,
        truncate_page,
    },
};

const DDG_HTML: &str = r#"
<div class="results" id="links">
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
</div>
"#;

/// What a query that genuinely matched nothing looks like: still the results
/// page, still the container, with the notice in place of the result blocks.
const DDG_NO_RESULTS_HTML: &str = r#"
<div class="serp__results">
  <div class="results" id="links">
    <div class="no-results">No results.</div>
  </div>
</div>
"#;

/// What a captcha or anomaly interstitial looks like: HTTP 200, no results
/// container, nothing that identifies it as an answer to the query.
const DDG_ANOMALY_HTML: &str = r#"
<!DOCTYPE html><html><head><title>DuckDuckGo</title></head>
<body><div class="anomaly-modal__mask">
<p>Unfortunately, bots use DuckDuckGo too. Please complete the challenge below.</p>
</div></body></html>
"#;

const VEIL_SEARCH_JSON: &str = r#"{"results":[
  {"title":"Example Docs","url":"https://example.com/docs","snippet":"Official documentation for the example protocol."},
  {"title":"A story","url":"https://news.example.org/story","snippet":"What happened today."},
  {"title":"Local","url":"http://127.0.0.1/secret","snippet":"must not appear"}
]}"#;

/// A one-request stand-in for Veil's `/api/web/search`, spoken over a real
/// loopback socket. The bearer, the request body, and the coded-error shape are
/// the contract being tested, so they go over the wire rather than through a
/// hook in the middle of the client.
///
/// The join handle yields the raw request, so a test can assert what was sent.
async fn fake_veil_search(status: u16, body: String) -> (u16, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            // reqwest sends headers and body in one go here, but a split write
            // is legal, so wait until the declared body has actually arrived.
            let text = String::from_utf8_lossy(&request).into_owned();
            if let Some((head, rest)) = text.split_once("\r\n\r\n")
                && rest.len() >= declared_content_length(head)
            {
                break;
            }
        }
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        String::from_utf8_lossy(&request).into_owned()
    });
    (port, handle)
}

fn declared_content_length(head: &str) -> usize {
    head.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .unwrap_or(0)
}

/// A session in server mode: `web_search` goes to the Veil on `port` and the
/// DuckDuckGo path is not an option.
fn veil_search_session(cwd: &std::path::Path, port: u16) -> Arc<crate::session::Session> {
    let mut session = crate::session::test_session(cwd);
    let config = Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config).unwrap();
    config.provider.base_url = format!("http://127.0.0.1:{port}");
    config.provider.mode = crate::config::ProviderMode::Server;
    config.provider.veil_web_search = true;
    session
}

/// The same deployment with the feature absent: a server, but a Veil that never
/// advertised `web.search`. The desktop does not offer the tool here at all, so
/// this is what a call that arrives anyway must meet.
fn server_without_veil_search(cwd: &std::path::Path) -> Arc<crate::session::Session> {
    let mut session = crate::session::test_session(cwd);
    let config = Arc::get_mut(&mut Arc::get_mut(&mut session).unwrap().config).unwrap();
    config.provider.mode = crate::config::ProviderMode::Server;
    config.provider.veil_web_search = false;
    session
}

async fn run_web_search(
    session: Arc<crate::session::Session>,
    id: &str,
    query: &str,
) -> ToolResult {
    let cwd = session.config.cwd.clone();
    execute_tool(
        session,
        crate::session::test_sink(&cwd),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: id.into(),
            name: "web_search".into(),
            arguments: json!({ "query": query }),
            index: 0,
        },
    )
    .await
}

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

#[test]
fn search_engine_result_pages_are_not_fetchable() {
    let blocked = [
        "https://www.google.com/search?q=Crytica",
        "https://google.com/search?q=x",
        "https://www.bing.com/search?q=x",
        "https://search.yahoo.com/search?p=x",
        "https://search.brave.com/search?q=x",
        "https://html.duckduckgo.com/html/?q=x",
        "https://lite.duckduckgo.com/lite/?q=x",
        "https://duckduckgo.com/?q=x",
    ];
    for url in blocked {
        let parsed = url::Url::parse(url).unwrap();
        assert!(is_search_results_page(&parsed), "{url}");
    }
    assert!(!is_search_results_page(
        &url::Url::parse("https://www.cryticasecurity.com/").unwrap()
    ));
    assert!(!is_search_results_page(
        &url::Url::parse("https://news.google.com/articles/abc").unwrap()
    ));
}

#[tokio::test]
async fn web_search_formats_stubbed_ddg_results() {
    let _http = set_test_http(Box::new(|method, url| {
        assert_eq!(method, "POST");
        assert!(url.contains("duckduckgo.com"));
        Ok(DDG_HTML.to_owned())
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        crate::session::test_session(directory.path()),
        "search-1",
        "example protocol",
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert!(result.content.contains("https://example.com/docs"));
    assert!(result.content.contains("web_fetch"));
    assert!(!result.content.contains("127.0.0.1"));
}

#[tokio::test]
async fn a_ddg_results_page_with_no_results_does_not_invite_a_guessed_url() {
    let _http = set_test_http(Box::new(|_, _| Ok(DDG_NO_RESULTS_HTML.to_owned())));
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        crate::session::test_session(directory.path()),
        "search-empty",
        "Crytica Security",
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert!(result.content.contains("not proof"));
    assert!(result.content.contains("Do not invent a domain"));
}

#[tokio::test]
async fn a_ddg_interstitial_is_a_failed_search_not_an_empty_one() {
    let _http = set_test_http(Box::new(|_, _| Ok(DDG_ANOMALY_HTML.to_owned())));
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        crate::session::test_session(directory.path()),
        "search-anomaly",
        "Crytica Security",
    )
    .await;
    assert_eq!(result.status, "runtime_error", "{}", result.content);
    let message = result.error_message.expect("runtime error names the page");
    assert!(message.contains("unavailable"), "{message}");
    assert!(message.contains("not an empty result set"), "{message}");
    assert!(!result.content.contains("No indexed hits"));
}

/// The desktop withholds `web_search` on a server whose Veil cannot search, so
/// a call arriving here means that trusted configuration is wrong. The runner
/// still refuses: the boundary is the runner's to enforce, and one desktop bug
/// must not be able to carry a query out of the company.
#[tokio::test]
async fn server_mode_without_the_feature_refuses_instead_of_searching_directly() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("a server without web.search must not reach a search engine");
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        server_without_veil_search(directory.path()),
        "server-no-feature",
        "Crytica Security",
    )
    .await;
    assert_eq!(result.status, "policy_blocked", "{}", result.content);
    let message = result.error_message.expect("a refusal names the reason");
    assert!(
        message.contains("not available on this server"),
        "{message}"
    );
    // The refusal must not read as "the web holds nothing", and must not point
    // the model at a results page as a way around it.
    assert!(message.contains("not an empty result set"), "{message}");
    assert!(!result.content.contains("No indexed hits"));
}

#[tokio::test]
async fn veil_search_sends_the_query_and_returns_veils_results() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("server mode must never query a search engine from this machine");
    }));
    let (port, server) = fake_veil_search(200, VEIL_SEARCH_JSON.to_owned()).await;
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        veil_search_session(directory.path(), port),
        "veil-search-1",
        "example protocol",
    )
    .await;
    assert_eq!(result.status, "success", "{}", result.content);
    assert!(result.content.contains("https://example.com/docs"));
    assert!(result.content.contains("https://news.example.org/story"));
    // Veil already drops private hosts; the runner checks again anyway.
    assert!(!result.content.contains("127.0.0.1"));
    let request = server.await.unwrap();
    assert!(
        request.starts_with("POST /api/web/search HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        request.ends_with(r#"{"query":"example protocol"}"#),
        "{request}"
    );
}

#[tokio::test]
async fn veil_coded_errors_become_tool_errors_the_model_can_act_on() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("a refused Veil search must not fall through to a search engine");
    }));
    for (status, code, expected) in [
        (404_u16, "web_search_unconfigured", "not configured"),
        (429, "rate_limited", "rate-limited"),
        (
            429,
            "web_search_quota_exhausted",
            "monthly web-search allowance",
        ),
        (502, "web_search_unavailable", "unavailable"),
        // An unknown code still has to read as a failed search, not as an
        // answer: this Veil may be newer than this runner.
        (500, "something_new", "something_new"),
    ] {
        let (port, server) =
            fake_veil_search(status, format!(r#"{{"error":"nope","code":"{code}"}}"#)).await;
        let directory = tempfile::tempdir().unwrap();
        let result = run_web_search(
            veil_search_session(directory.path(), port),
            "veil-error",
            "Crytica Security",
        )
        .await;
        assert_eq!(result.status, "runtime_error", "{code}: {}", result.content);
        let message = result.error_message.expect("runtime error names the cause");
        assert!(message.contains(expected), "{code}: {message}");
        assert!(
            message.contains("not an empty result set"),
            "{code}: {message}"
        );
        assert!(!result.content.contains("No indexed hits"), "{code}");
        assert!(
            !result.content.to_ascii_lowercase().contains("duckduckgo"),
            "{code}"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn an_unreachable_veil_fails_the_search_rather_than_going_direct() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("an unreachable Veil must not become a direct search");
    }));
    // Bind and drop, so the port is one nothing is listening on.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        veil_search_session(directory.path(), port),
        "veil-unreachable",
        "Crytica Security",
    )
    .await;
    assert_eq!(result.status, "runtime_error", "{}", result.content);
    let message = result.error_message.expect("runtime error names the cause");
    assert!(message.contains("could not reach the server"), "{message}");
    assert!(!result.content.contains("No indexed hits"));
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
async fn web_fetch_refuses_a_search_engine_results_page() {
    let _http = set_test_http(Box::new(|_, _| {
        panic!("search result pages must not reach HTTP");
    }));
    let directory = tempfile::tempdir().unwrap();
    let result = execute_tool(
        crate::session::test_session(directory.path()),
        crate::session::test_sink(directory.path()),
        Arc::new(crate::permission::PermissionBroker::default()),
        ToolCall {
            id: "fetch-serp".into(),
            name: "web_fetch".into(),
            arguments: json!({ "url": "https://www.google.com/search?q=Crytica" }),
            index: 0,
        },
    )
    .await;
    assert_eq!(result.status, "policy_blocked");
    assert!(
        result
            .error_message
            .unwrap()
            .contains("search-engine results page")
    );
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

#[tokio::test]
async fn a_veil_200_that_is_not_a_result_set_is_a_failed_search_not_an_empty_one() {
    // A proxy or captive sign-on in front of Veil answering an expired session
    // with its own 200 is the shape this guards. Read leniently it becomes "no
    // hits", which tells the model the web holds nothing on the subject — the
    // same lie the DuckDuckGo interstitial used to tell.
    let _http = set_test_http(Box::new(|_, _| {
        panic!("a malformed Veil answer must not fall through to a search engine");
    }));
    let (port, server) = fake_veil_search(200, r#"{"status":"ok"}"#.to_owned()).await;
    let directory = tempfile::tempdir().unwrap();
    let result = run_web_search(
        veil_search_session(directory.path(), port),
        "veil-search-malformed",
        "example protocol",
    )
    .await;
    assert_eq!(result.status, "runtime_error", "{}", result.content);
    assert!(
        !result.content.contains("No indexed hits"),
        "{}",
        result.content
    );
    let _ = server.await;
}
