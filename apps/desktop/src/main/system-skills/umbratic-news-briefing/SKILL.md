---
name: News Briefing
description: Use for current daily or weekly news in a sector, company, or beat, pulling live pages with web_search and web_fetch and preferring independent newsrooms over aggregators.
---

# News Briefing

A current briefing for a sector, company, geography, or beat. Not a competitor landscape — that is competitive research.

If `web_search` and `web_fetch` are not in the current tools array, say you cannot retrieve live pages and stop. Do not narrate "today's news" from training data.

## Tools

Umbratic search returns results from the public web. Fetch is a bounded GET of one public page.

- `web_search` takes exactly `query`. Distill it. Results are at most five titles, URLs, and snippets. Snippets are leads, not evidence, and they carry no reliable date.
- `web_fetch` takes exactly one absolute `http` or `https` `url`. Read the page. Dates, headlines, and quotations come from the fetched text, not from the snippet.
- Search, then fetch. Direct-fetch a known newsroom URL when you know it. Never invent a company domain.
- An empty search or a search error is not proof the company is missing; ask for a URL. Do not fetch Google, Bing, Yahoo, DuckDuckGo, or search.brave.com as a substitute for `web_search`.
- Independent searches and fetches belong in one response. Fetch three to five independent stories, not one aggregator's homepage.

## Who to read

Prefer, in this order:

1. **Wires** — Reuters, AP, AFP. One wire story reprinted six times is still one story.
2. **Public newsrooms** — BBC, NPR, PBS, CBC, ABC Australia, DW.
3. **Business desks** — Bloomberg, Financial Times, Wall Street Journal, Nikkei Asia, The Economist.
4. **Beat desks** — the established journal of that sector (STAT or Fierce for biotech, Ars Technica or IEEE Spectrum for computing, American Banker for US banking, Utility Dive for energy, Law360 or a court site for legal). One named outlet, not a roundup blog.
5. **Primary documents the news is about** — an `8-K`, a regulator notice, a company IR release. Fetch these when a newsroom story points at them.

Skip as confirmation: SEO listicles, "top stories" farms, social posts, forums, Reddit, other AI summaries, and homepages that mix unpaid advertorial with news.

Bias search with `site:` (`site:reuters.com`, `site:ft.com`, `site:bbc.com`) rather than taking whichever host ranked first.

## Method

1. Lock the beat: sector or company, geography, and window (default the last 24–48 hours unless they named one).
2. Search with tight queries: `{beat} {window}`, `{beat} site:reuters.com`, `{company} 8-K` or the local filing equivalent, plus one sector journal if you know it.
3. Fetch the pages. Drop duplicates of the same wire. Note when several outlets are reprinting one alert.
4. For each item: what happened, who, when (from the page), why it matters for this beat, URL, what is still unconfirmed.
5. Separate **reported**, **company claims**, and **rumor**.

Lead with the few items that change a decision. Evergreen background only if they asked for context.

## Claims

Cite the URL on every item. Do not invent a date, quotation, or death toll. If the page has no timestamp, say so. A briefing with three sourced items is better than ten unsourced ones.
