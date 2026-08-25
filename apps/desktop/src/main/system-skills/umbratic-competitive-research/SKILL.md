---
name: Competitive Research
description: Use for competitor landscapes, battlecards, win/loss from public sources, alternative comparisons, and pricing or positioning research, using web_search and web_fetch with a source trust order.
---

# Competitive Research

Public competitive intelligence. Ground every claim in what the user supplied or in a page you fetched this turn. Training data is not a live source.

If `web_search` and `web_fetch` are not in the current tools array, work only from supplied material, label every gap, and stop. Do not invent a landscape.

## Tools

Umbratic search returns results from the public web. Fetch is a bounded GET of one public page. Neither is Google, Bing, or a browser.

- `web_search` takes exactly `query` (distill it; do not paste the whole prompt). It returns at most five titles, URLs, and short snippets. Snippets are leads, not evidence.
- `web_fetch` takes exactly `url`, an absolute `http` or `https` URL from a search hit or one the user gave. It returns readable text. Private, loopback, and credentialed URLs are blocked.
- If search already returned a host, fetch `/pricing`, `/docs`, IR, or a filing on that host. Never invent a domain.
- An empty result or a search error is not proof the subject is missing from the web. Ask the user for a URL. Do not fetch Google, Bing, Yahoo, DuckDuckGo, or search.brave.com as a substitute for `web_search`.
- Bias search with `site:` toward a trusted host: `site:sec.gov`, `site:reuters.com`, `site:ft.com`.
- Independent searches and fetches belong in one response. Two or three independent pages beat fifteen thin snippets.
- If a fetch returns no readable text, try another URL. Some sites are script-heavy and yield almost nothing.

## Source order

Work top-down. A lower tier never overrides a higher one without saying so.

1. **Primary documents** — the company's IR site; SEC EDGAR (`10-K`, `10-Q`, `8-K`); Companies House; SEDAR+; official product, pricing, docs, changelog, and GitHub; regulator notices (FDA, USPTO, CISA, EUR-Lex, EIA, IEA).
2. **Independent newsrooms** — Reuters, AP, AFP; BBC, NPR, PBS; Bloomberg, Financial Times, Wall Street Journal, Nikkei Asia, The Economist.
3. **Sector trade press** — one established journal of that industry, not a roundup blog. Corroborate material numbers.
4. **Orientation only** — Wikipedia (then fetch its citations), company blogs, LinkedIn, earnings-call color, Business Wire / PR Newswire, job postings as a weak signal for stack or org.
5. **Not evidence** — SEO listicles, "top 10" affiliate posts, forums, Reddit, social posts, unsourced aggregators, other AI summaries.

Do not fetch a ranking page because it appeared first.

## Workflow

1. Frame the decision: who we are, the category, named alternatives, what this brief is for.
2. Start with user-named competitors. Add others only from tiers 1–3, labelled as found.
3. For each alternative, collect only what is published: offering, packaging or pricing if public, stated positioning, last material public move, obvious strengths and gaps.
4. Corroborate any number, share claim, or "they just launched X" with a second independent source, or mark it unconfirmed.
5. Implications: our wedge, proof we would need, claims we must not make.
6. Open questions: what is still private — win rates, discounting, unpublished pricing, roadmap, actual usage.

A comparison table plus recent moves plus sources is the default shape. Narrative tours waste the reader.

## Claims

Label every factual sentence **user-supplied**, **observed** (URL), or **inferred**.

Never invent headcount, revenue, funding, market share, uptime, or quotes. Never disparage. Never write customer-facing copy from an uncorroborated public claim. A differentiator without proof is a hypothesis.

If they asked for a battlecard, one-pager, or deck, gather the facts first, then load the matching artifact skill.
