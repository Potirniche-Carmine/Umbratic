// Package websearch runs public web searches on behalf of the whole company.
//
// The search leaves from Veil rather than from each desktop. A query is the
// user's own words, and letting every laptop send them straight to a search API
// would carry them outside the company boundary this deployment exists to
// enforce, one uncontrolled egress at a time. It also means one subscription and
// one budget instead of a credential on every machine.
package websearch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// SubscriptionKey is set in customer release binaries with -ldflags: one Brave
// Search subscription token. A build without it has no search, which is what a
// development or evaluation server should do.
var SubscriptionKey string

// Key returns the token this process should present. Release binaries bake it
// in at build time; VEIL_WEB_SEARCH_API_KEY overrides it during development,
// where there is no signing machine to bake anything.
func Key() string {
	if override := strings.TrimSpace(os.Getenv("VEIL_WEB_SEARCH_API_KEY")); override != "" {
		return override
	}
	return strings.TrimSpace(SubscriptionKey)
}

const (
	searchEndpoint = "https://api.search.brave.com/res/v1/web/search"

	// MaxResults is what one search hands back. Snippets are leads for a
	// follow-up fetch, not evidence, and a longer list buys the model more to
	// choose badly from rather than more to know.
	MaxResults = 5

	// minSpacing holds outbound calls at the credit plan's 1 QPS. Veil is now
	// the single point the whole organization's searches funnel through, so the
	// spacing that used to be one desktop's problem is the company's.
	minSpacing = time.Second

	// maxResponseBytes bounds what is read from upstream. A result page of five
	// snippets is a few kilobytes; anything near this is not an answer.
	maxResponseBytes = 1 << 20
)

// blockedHosts are names an internal service answers on. They never resolve to
// anything a public search result should be pointing at.
var blockedHosts = []string{
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.tencentyun.com",
}

// Result is one hit, in the shape the route returns it.
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// Client calls the search API. Built once at startup like the model clients, so
// no request assembles an endpoint or reads a credential out of configuration.
type Client struct {
	key      string
	endpoint string
	http     *http.Client
	// gate serializes outbound calls and carries the last call's start time.
	// A one-slot channel rather than a mutex because a caller waiting its turn
	// must still be able to give up when its request context ends.
	gate chan time.Time
}

func NewClient(key string, timeout time.Duration) *Client {
	gate := make(chan time.Time, 1)
	gate <- time.Time{}
	return &Client{
		key:      strings.TrimSpace(key),
		endpoint: searchEndpoint,
		http:     &http.Client{Timeout: timeout},
		gate:     gate,
	}
}

// Search returns at most MaxResults public hits for the query.
//
// Every error it returns is deliberately shapeless. The transport error text
// net/http produces carries the request URL, and this request's URL carries the
// user's query; the subscription token travels in a header and must never reach
// a log either. A status code says everything an operator can act on.
func (c *Client) Search(ctx context.Context, query string) ([]Result, error) {
	var last time.Time
	select {
	case last = <-c.gate:
	case <-ctx.Done():
		return nil, errors.New("web search: canceled before the request was sent")
	}
	if wait := minSpacing - time.Since(last); wait > 0 {
		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			c.gate <- last
			return nil, errors.New("web search: canceled while waiting for its turn")
		}
	}
	started := time.Now()
	defer func() { c.gate <- started }()

	endpoint, err := url.Parse(c.endpoint)
	if err != nil {
		return nil, errors.New("web search: the configured endpoint is not a URL")
	}
	endpoint.RawQuery = url.Values{
		"q":     {query},
		"count": {strconv.Itoa(MaxResults)},
	}.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, errors.New("web search: building the request failed")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Language", "en-US,en;q=0.9")
	request.Header.Set("User-Agent", "Umbratic")
	request.Header.Set("X-Subscription-Token", c.key)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, errors.New("web search: the upstream request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// The body is drained but never surfaced: an upstream error page can
		// echo the request, and the request holds the query.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("web search: upstream returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, errors.New("web search: reading the upstream response failed")
	}
	return parseResults(body)
}

// parseResults reads the upstream answer.
//
// A body that is not the documented JSON is an error rather than an empty
// result set. "Nothing was found" and "the search never happened" mean opposite
// things to a model: the first is a fact about the web, and a captcha or an
// outage page reported as zero hits is what teaches one to invent a domain
// instead of saying it could not look.
func parseResults(body []byte) ([]Result, error) {
	var payload struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return nil, errors.New("web search: upstream returned an unreadable response")
	}
	results := make([]Result, 0, MaxResults)
	for _, entry := range payload.Web.Results {
		if len(results) == MaxResults {
			break
		}
		address := strings.TrimSpace(entry.URL)
		if !publicHTTPURL(address) {
			continue
		}
		results = append(results, Result{
			Title:   collapse(entry.Title),
			URL:     address,
			Snippet: collapse(entry.Description),
		})
	}
	return results, nil
}

// publicHTTPURL reports whether a hit is safe to put in front of a model that
// will turn around and fetch it. The same filter web_fetch applies, applied
// here too, so a poisoned or misindexed result cannot smuggle an internal
// address into the fetch tool by way of a snippet.
func publicHTTPURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	if parsed.User != nil {
		return false
	}
	host := strings.TrimSuffix(parsed.Hostname(), ".")
	if host == "" {
		return false
	}
	for _, blocked := range blockedHosts {
		if strings.EqualFold(host, blocked) {
			return false
		}
	}
	if address, err := netip.ParseAddr(host); err == nil && !publicAddr(address) {
		return false
	}
	return true
}

// publicAddr refuses every address an internal service could answer on,
// including the ranges Go's own IsPrivate does not cover: carrier-grade NAT,
// the documentation blocks, and 0.0.0.0/8.
func publicAddr(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || address.IsUnspecified() || address.IsLoopback() ||
		address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() ||
		address.IsMulticast() || address.IsInterfaceLocalMulticast() {
		return false
	}
	if !address.Is4() {
		return true
	}
	octets := address.As4()
	switch {
	case octets[0] == 0:
		return false
	case octets[0] == 100 && octets[1]&0xc0 == 64:
		return false
	case octets[0] == 192 && octets[1] == 0 && octets[2] == 2:
		return false
	case octets[0] == 198 && octets[1] == 51 && octets[2] == 100:
		return false
	case octets[0] == 203 && octets[1] == 0 && octets[2] == 113:
		return false
	case octets == [4]byte{255, 255, 255, 255}:
		return false
	}
	return true
}

func collapse(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
