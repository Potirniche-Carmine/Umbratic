//! Public web search and page fetch.
//!
//! Search has two backends and the deployment picks one. Pointed at a Veil that
//! advertises `web.search`, the runner posts the query to Veil and Veil runs the
//! search: that is the whole point of a server deployment, and sending the query
//! straight out of this machine would carry it past the boundary the deployment
//! exists to enforce. In local mode the runner queries DuckDuckGo's HTML
//! endpoint itself, with no credential of any kind. There is deliberately no
//! fallback from the first to the second — and a server whose Veil does not
//! advertise the feature is the third case, where the search simply does not
//! happen.
//!
//! Fetch is a bounded GET from this machine either way. Neither path fans out to
//! Google or Bing.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    time::Duration,
};

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value, json};
use url::Url;

use super::{Session, ToolError, ToolExecutionResult, ToolResult, string_arg};
use crate::config::ProviderMode;
use crate::veil_client::{VeilWebSearchError, veil_web_search};

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

/// What the model is told when a query genuinely matched nothing. It has to say
/// so without implying the subject does not exist: read as "there is nothing out
/// there", an empty result set is what makes a model invent a plausible domain.
const NO_HITS: &str = "No indexed hits for this query. That is not proof the subject is missing from the web. Do not invent a domain. If the user can share a URL, web_fetch it.";

pub(super) async fn web_search_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let query = string_arg(input, &["query"]);
    // A server deployment whose Veil cannot search has no route for this query
    // that stays inside the boundary, so there is nothing to try. The desktop
    // already withholds the tool in that case; this is the runner refusing it
    // anyway, because the runner is what enforces the boundary and a bug in
    // trusted configuration must not be able to walk a query out of the
    // company.
    if session.config.provider.mode == ProviderMode::Server
        && !session.config.provider.veil_web_search
    {
        return Err(ToolError::policy(search_did_not_run(
            "web_search is not available on this server. Tell the user their administrator has not enabled web search.",
        )));
    }
    let hits = if session.config.provider.veil_web_search {
        veil_search(session, &query).await?
    } else {
        duckduckgo_search(&query).await?
    };
    if hits.is_empty() {
        return Ok(ToolResult::success(query, NO_HITS));
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

/// The server-mode path: Veil searches, the runner only reads the answer. A
/// failure here is the end of the search — falling back to DuckDuckGo would send
/// the query out of this machine, which is exactly what this deployment forbids.
async fn veil_search(session: &Session, query: &str) -> Result<Vec<SearchHit>, ToolError> {
    let results = veil_web_search(session, query)
        .await
        .map_err(veil_search_error)?;
    Ok(results
        .iter()
        .filter_map(|result| {
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            // Veil drops private, loopback, and link-local hosts before it
            // answers. Checking again costs nothing and means one forgetful
            // server cannot talk this machine into fetching its own network.
            if url.is_empty() || check_public_url(url).is_err() {
                return None;
            }
            Some(SearchHit {
                title: collapse_ws(result.get("title").and_then(Value::as_str).unwrap_or("")),
                url: url.to_owned(),
                snippet: collapse_ws(result.get("snippet").and_then(Value::as_str).unwrap_or("")),
            })
        })
        .collect())
}

/// The tail every failed search carries. A model that reads "the search did not
/// run" as "the web holds nothing" invents a plausible domain, and one that
/// reads it as "try another way" fetches a results page, so both are closed off
/// wherever the search does not happen.
fn search_did_not_run(message: &str) -> String {
    format!(
        "{message} That is not an empty result set — do not invent a domain and do not fetch a search-engine results page instead."
    )
}

/// Turns Veil's coded refusals into something the model can act on. Every arm
/// has to be unmistakably "the search did not run", never "the search found
/// nothing", and none of them may suggest reaching for a results page instead.
fn veil_search_error(error: VeilWebSearchError) -> ToolError {
    let message = match error {
        VeilWebSearchError::Coded(code) => match code.as_str() {
            "web_search_unconfigured" => {
                "web_search is not configured on this server. Tell the user their administrator has not enabled web search."
                    .to_owned()
            }
            "rate_limited" => {
                "The server rate-limited this search. Wait a moment and retry.".to_owned()
            }
            "web_search_quota_exhausted" => {
                "This organization's monthly web-search allowance is spent. Tell the user; it resets next month."
                    .to_owned()
            }
            "web_search_unavailable" => {
                "Web search is unavailable right now: the server could not complete the search."
                    .to_owned()
            }
            other => format!("Web search failed on the server ({other})."),
        },
        VeilWebSearchError::Transport(detail) => {
            format!("Web search could not reach the server: {detail}.")
        }
    };
    ToolError::runtime(search_did_not_run(&message))
}

/// The local path: one POST to DuckDuckGo's documented HTML endpoint, no key.
async fn duckduckgo_search(query: &str) -> Result<Vec<SearchHit>, ToolError> {
    let html = http_text(
        "POST",
        SEARCH_ENDPOINT,
        Some(&[("q", query), ("kl", "us-en")]),
    )
    .await?
    .body;
    let hits = parse_ddg_html(&html);
    if hits.is_empty() && !is_ddg_results_page(&html) {
        return Err(ToolError::runtime(search_did_not_run(
            "Web search is unavailable right now: the search endpoint answered with a challenge page instead of results.",
        )));
    }
    Ok(hits)
}

/// Markers a real DuckDuckGo results page carries even when it matched nothing:
/// the result container, and the "no results" notice that sits inside it.
const DDG_RESULTS_MARKERS: &[&str] = &["id=\"links\"", "class=\"results\"", "class=\"no-results\""];

/// Whether the body we got back is a results page at all.
///
/// A captcha or anomaly interstitial comes back as a perfectly normal 200 with
/// no result blocks in it, which parses to the same empty list an honest
/// zero-result page does — and the model reads "no results" as proof the subject
/// is absent from the web. Only a body that still looks like the results page is
/// allowed to mean "nothing matched"; anything else is a failed search. If DDG
/// ever renames these containers this starts erring on live pages, which is the
/// safe direction to be wrong in.
fn is_ddg_results_page(html: &str) -> bool {
    DDG_RESULTS_MARKERS
        .iter()
        .any(|marker| html.contains(marker))
}

pub(super) async fn web_fetch_tool(input: &Map<String, Value>) -> ToolExecutionResult {
    let raw_url = string_arg(input, &["url"]);
    let url = check_public_url(&raw_url)?;
    if is_search_results_page(&url) {
        return Err(ToolError::policy(
            "web_fetch is for a specific page, not a search-engine results page. Use web_search.",
        ));
    }
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

/// Search-engine result pages are not a substitute for `web_search`. Fetching
/// Google, Bing, Yahoo, or another SERP is what produced empty "the company
/// does not exist" answers after a failed search.
pub(super) fn is_search_results_page(url: &Url) -> bool {
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let path = url.path().to_ascii_lowercase();
    let query = url.query().unwrap_or("");
    if host == "html.duckduckgo.com" || host == "lite.duckduckgo.com" {
        return true;
    }
    if host == "duckduckgo.com"
        && (path == "/"
            || path == "/html"
            || path == "/html/"
            || path.starts_with("/lite")
            || query.contains("q="))
    {
        return true;
    }
    if host == "search.yahoo.com" || host == "search.brave.com" {
        return true;
    }
    if host == "bing.com" && path.starts_with("/search") {
        return true;
    }
    let google = host == "google.com" || host.starts_with("google.");
    google
        && (path.starts_with("/search") || path.starts_with("/webhp") || path.starts_with("/url"))
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
