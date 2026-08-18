//! Public web search and page fetch. Search hits one documented HTML endpoint
//! (DuckDuckGo). Fetch is a bounded GET from this machine. Neither is a paid
//! API, and neither fans out to Google or Bing.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    time::Duration,
};

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value, json};
use url::Url;

use super::{ToolError, ToolExecutionResult, ToolResult, string_arg};

const SEARCH_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const MAX_RESULTS: usize = 5;
/// How much readable text one fetch hands back. The runner's context pipeline
/// already shows anything past 16 KB as a head-and-tail preview and keeps the
/// rest for the model to page through, so this is a ceiling on what is worth
/// keeping, not on what the model sees at once. A long article fits; a page
/// beyond it is cut with a note saying how much there was.
const MAX_PAGE_CHARS: usize = 100_000;
/// How much of a response is read off the wire. Read up to here and stop,
/// rather than fail: a news front page is a few megabytes of markup and script
/// around a few kilobytes of prose, and refusing the whole page because the
/// script was heavy answered the model with nothing.
const MAX_FETCH_BYTES: usize = 5 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// DDG's HTML endpoint refuses non-browser clients. This is a fetch UA, not a
/// claim that we are Chrome.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCKED_HOSTS: &[&str] = &[
    "localhost",
    "metadata",
    "metadata.google.internal",
    "metadata.tencentyun.com",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

pub(super) async fn web_search_tool(input: &Map<String, Value>) -> ToolExecutionResult {
    let query = string_arg(input, &["query"]);
    let html = http_text(
        "POST",
        SEARCH_ENDPOINT,
        Some(&[("q", query.as_str()), ("kl", "us-en")]),
    )
    .await?
    .body;
    let hits = parse_ddg_html(&html);
    if hits.is_empty() {
        return Ok(ToolResult::success(
            query,
            "No results found. Try a more specific query, or web_fetch a known URL.",
        ));
    }
    let shown = hits.into_iter().take(MAX_RESULTS).collect::<Vec<_>>();
    let mut parts = Vec::new();
    let mut details = Vec::new();
    for hit in &shown {
        parts.push(format!(
            "Title: {}\nURL: {}\nSnippet: {}",
            hit.title, hit.url, hit.snippet
        ));
        details.push(json!({
            "title": hit.title,
            "url": hit.url,
            "snippet": hit.snippet,
        }));
    }
    parts
        .push("These are short snippets. Call web_fetch with one URL to read the page.".to_owned());
    Ok(ToolResult::success_detailed(
        query,
        parts.join("\n\n---\n\n"),
        Some(json!({ "results": details })),
        None,
    ))
}

pub(super) async fn web_fetch_tool(input: &Map<String, Value>) -> ToolExecutionResult {
    let raw_url = string_arg(input, &["url"]);
    let url = check_public_url(&raw_url)?;
    let fetched = http_text("GET", url.as_str(), None).await?;
    let mut text = truncate_page(&readable_text(&fetched.body));
    if fetched.truncated {
        text.push_str(&format!(
            "\n\n... (the page was longer than {} MB; only the first part was fetched)",
            MAX_FETCH_BYTES / (1024 * 1024)
        ));
    }
    Ok(ToolResult::success_detailed(
        url.to_string(),
        text,
        Some(json!({ "url": url.as_str(), "truncated": fetched.truncated })),
        None,
    ))
}

pub(super) fn check_public_url(raw: &str) -> Result<Url, ToolError> {
    let url = Url::parse(raw.trim())
        .map_err(|_| ToolError::policy("web_fetch url must be an absolute http or https URL."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ToolError::policy(format!(
            "Blocked: only http/https URLs are allowed (got {}).",
            url.scheme()
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::policy(
            "Blocked: URLs with credentials are not allowed.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::policy("Blocked: URL is missing a hostname."))?;
    if BLOCKED_HOSTS
        .iter()
        .any(|blocked| host.eq_ignore_ascii_case(blocked))
    {
        return Err(ToolError::policy(format!(
            "Blocked: {host} is not a public host."
        )));
    }
    if let Ok(ip) = host.parse::<IpAddr>()
        && !is_public_ip(ip)
    {
        return Err(ToolError::policy(format!(
            "Blocked: {host} is not a public address."
        )));
    }
    Ok(url)
}

fn allow_public_destination(raw: &str) -> Result<Url, ToolError> {
    let url = check_public_url(raw)?;
    resolve_public_host(&url)?;
    Ok(url)
}

fn resolve_public_host(url: &Url) -> Result<(), ToolError> {
    let host = url
        .host_str()
        .ok_or_else(|| ToolError::policy("Blocked: URL is missing a hostname."))?;
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ToolError::policy("Blocked: URL is missing a port."))?;
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|_| ToolError::policy(format!("Blocked: could not resolve {host}.")))?;
    let mut saw_address = false;
    for addr in addrs {
        saw_address = true;
        if !is_public_ip(addr.ip()) {
            return Err(ToolError::policy(format!(
                "Blocked: {host} resolved to a non-public address."
            )));
        }
    }
    if !saw_address {
        return Err(ToolError::policy(format!(
            "Blocked: {host} resolved to no addresses."
        )));
    }
    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_private()
        && !ip.is_link_local()
        && !ip.is_broadcast()
        && !ip.is_documentation()
        && !ip.is_multicast()
        && !(octets[0] == 100 && octets[1] & 0xc0 == 64)
        && octets[0] != 0
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_multicast()
        && !ip.is_unique_local()
        && !ip.is_unicast_link_local()
        && ip.to_ipv4_mapped().is_none_or(is_public_ipv4)
}

pub(super) fn parse_ddg_html(html: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("class=\"result__a\"") {
        let after_class = &rest[start + "class=\"result__a\"".len()..];
        let Some(href) = attribute_after(after_class, "href").or_else(|| {
            rest[..start]
                .rfind("<a")
                .and_then(|tag| attribute_after(&rest[tag..start], "href"))
        }) else {
            rest = after_class;
            continue;
        };
        let Some(title_html) = inner_html_after_open(after_class) else {
            rest = after_class;
            continue;
        };
        let url = decode_result_url(&href);
        if check_public_url(&url).is_err() {
            rest = after_class;
            continue;
        }
        let snippet = next_class_inner(after_class, "result__snippet").unwrap_or_default();
        hits.push(SearchHit {
            title: collapse_ws(&strip_tags(&title_html)),
            url,
            snippet: collapse_ws(&strip_tags(&snippet)),
        });
        rest = after_class;
    }
    hits
}

fn decode_result_url(href: &str) -> String {
    let absolute = if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href.to_owned()
    };
    if let Ok(url) = Url::parse(&absolute) {
        for (key, value) in url.query_pairs() {
            if key == "uddg" && value.starts_with("http") {
                return value.into_owned();
            }
        }
        if url.scheme() == "http" || url.scheme() == "https" {
            return url.to_string();
        }
    }
    href.to_owned()
}

fn attribute_after(source: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = source.find(&needle)? + needle.len();
    let end = source[start..].find('"')?;
    Some(source[start..start + end].to_owned())
}

fn inner_html_after_open(source: &str) -> Option<String> {
    let start = source.find('>')? + 1;
    let end = source[start..].find("</a>")?;
    Some(source[start..start + end].to_owned())
}

fn next_class_inner(source: &str, class: &str) -> Option<String> {
    let marker = format!("class=\"{class}\"");
    let at = source.find(&marker)?;
    inner_html_after_open(&source[at..])
}

pub(super) fn readable_text(body: &str) -> String {
    let without_blocks = strip_blocks(body, &["script", "style", "noscript", "svg"]);
    collapse_ws(&strip_tags(&without_blocks))
}

/// Removes whole elements — script, style, and friends — in one pass over the
/// document. Lowercased once for matching; the output is copied from the
/// original, so nothing outside the removed elements changes case.
fn strip_blocks(input: &str, tags: &[&str]) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find('<') {
        let at = cursor + offset;
        let after = &lower[at + 1..];
        let matched = tags.iter().find(|tag| {
            after.starts_with(*tag)
                && after[tag.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| next == '>' || next == '/' || next.is_ascii_whitespace())
        });
        let Some(tag) = matched else {
            output.push_str(&input[cursor..=at]);
            cursor = at + 1;
            continue;
        };
        output.push_str(&input[cursor..at]);
        output.push(' ');
        let content_start = lower[at..]
            .find('>')
            .map_or(input.len(), |index| at + index + 1);
        let close = format!("</{tag}");
        cursor = lower[content_start..]
            .find(&close)
            .map_or(input.len(), |index| {
                let close_at = content_start + index;
                lower[close_at..]
                    .find('>')
                    .map_or(input.len(), |end| close_at + end + 1)
            });
    }
    output.push_str(&input[cursor..]);
    output
}

fn strip_tags(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    html_unescape(&output)
}

fn html_unescape(input: &str) -> String {
    decode_numeric_entities(
        &input
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&nbsp;", " "),
    )
}

fn decode_numeric_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("&#") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some((ch, consumed)) = take_numeric_entity(after) {
            output.push(ch);
            rest = &after[consumed..];
        } else {
            output.push_str("&#");
            rest = after;
        }
    }
    output.push_str(rest);
    output
}

fn take_numeric_entity(after_hash: &str) -> Option<(char, usize)> {
    let hex = after_hash.starts_with('x') || after_hash.starts_with('X');
    let digits = if hex { &after_hash[1..] } else { after_hash };
    let length = digits
        .chars()
        .take_while(|ch| {
            if hex {
                ch.is_ascii_hexdigit()
            } else {
                ch.is_ascii_digit()
            }
        })
        .count();
    if length == 0 {
        return None;
    }
    let value = if hex {
        u32::from_str_radix(&digits[..length], 16).ok()?
    } else {
        digits[..length].parse().ok()?
    };
    let ch = char::from_u32(value)?;
    let mut consumed = usize::from(hex) + length;
    if digits[length..].starts_with(';') {
        consumed += 1;
    }
    Some((ch, consumed))
}

fn collapse_ws(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn truncate_page(text: &str) -> String {
    if text.is_empty() {
        return "(page returned no readable text)".to_owned();
    }
    let total = text.chars().count();
    if total <= MAX_PAGE_CHARS {
        return text.to_owned();
    }
    let clipped: String = text.chars().take(MAX_PAGE_CHARS).collect();
    format!("{clipped}\n\n... (truncated: showing {MAX_PAGE_CHARS} of {total} characters)")
}

/// A response body, and whether it was cut at the read cap.
struct FetchedText {
    body: String,
    truncated: bool,
}

async fn http_text(
    method: &str,
    url: &str,
    form: Option<&[(&str, &str)]>,
) -> Result<FetchedText, ToolError> {
    if let Some(body) = test_http_override(method, url, form) {
        return body.map(|body| FetchedText {
            body,
            truncated: false,
        });
    }
    let parsed = allow_public_destination(url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            match allow_public_destination(attempt.url().as_str()) {
                Ok(_) => attempt.follow(),
                Err(_) => attempt.error("blocked redirect"),
            }
        }))
        .timeout(if method == "POST" {
            SEARCH_TIMEOUT
        } else {
            FETCH_TIMEOUT
        })
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| ToolError::runtime(error.to_string()))?;
    let request = if method == "POST" {
        let mut request = client.post(parsed.as_str());
        if let Some(form) = form {
            request = request.form(form);
        }
        request
    } else {
        client.get(parsed.as_str())
    };
    let response = request
        .send()
        .await
        .map_err(|error| ToolError::runtime(format!("Request failed: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ToolError::runtime(format!(
            "Request failed: HTTP {}",
            status.as_u16()
        )));
    }
    // Read up to the cap and stop, rather than buffer the whole body and then
    // refuse it: the useful part of a page is usually near the top, and the
    // model is better served by the first megabytes than by an error.
    let mut response = response;
    let mut bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ToolError::runtime(format!("Failed to read response: {error}")))?
    {
        let room = MAX_FETCH_BYTES - bytes.len();
        if chunk.len() >= room {
            bytes.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(FetchedText {
        body: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[cfg(test)]
type TestHttp = Box<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync>;

#[cfg(test)]
pub(super) struct TestHttpGuard {
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
fn recover<T>(result: std::sync::LockResult<T>) -> T {
    result.unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
fn test_http() -> &'static Mutex<Option<TestHttp>> {
    static CELL: OnceLock<Mutex<Option<TestHttp>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn test_http_serial() -> &'static Mutex<()> {
    static CELL: OnceLock<Mutex<()>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
pub(super) fn set_test_http(handler: TestHttp) -> TestHttpGuard {
    let serial = recover(test_http_serial().lock());
    *recover(test_http().lock()) = Some(handler);
    TestHttpGuard { _serial: serial }
}

#[cfg(test)]
impl Drop for TestHttpGuard {
    fn drop(&mut self) {
        *recover(test_http().lock()) = None;
    }
}

#[cfg(test)]
fn test_http_override(
    method: &str,
    url: &str,
    _form: Option<&[(&str, &str)]>,
) -> Option<Result<String, ToolError>> {
    let guard = recover(test_http().lock());
    guard
        .as_ref()
        .map(|handler| handler(method, url).map_err(ToolError::runtime))
}

#[cfg(not(test))]
fn test_http_override(
    _method: &str,
    _url: &str,
    _form: Option<&[(&str, &str)]>,
) -> Option<Result<String, ToolError>> {
    None
}
