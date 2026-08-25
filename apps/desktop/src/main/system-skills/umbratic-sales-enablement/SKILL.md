---
name: Sales Enablement
description: Use for account briefs, discovery call prep, objection handling, demo scripts, proposals, and sales enablement assets, including public-company research and claim discipline on customer-facing material.
---

# Sales Enablement

Customer-facing sales material. Grounded in supplied account facts, approved claims, and public pages you actually fetched this turn.

## Claim discipline

- Never invent firmographics: headcount, revenue, tech stack, funding, org structure. Look them up when the web tools are present; otherwise leave them unknown.
- Never invent customer references, win stories, or benchmark numbers.
- Never state pricing, terms, SLAs, or legal commitments the user did not supply.
- Unknowns go in an explicit **Open questions** list, not into the narrative.
- Use only proof points the user marked approved in anything the customer will see.
- Label factual sentences **user-supplied**, **observed** (URL), or **inferred**. Do not disparage competitors.

## Public research

When `web_search` and `web_fetch` are in the tools array, gather public facts about a named account or alternative before asking the user. Search is DuckDuckGo snippets only — fetch the page.

Fetch first: the company's IR and official site, SEC EDGAR or the local filing equivalent, recent independent news (Reuters, AP, Bloomberg, FT, WSJ), and official product or pricing pages. Job postings are a weak signal for stack or org, labelled as such.

If those tools are absent, use supplied notes and workspace files only and label the gaps. Do not narrate live firmographics from training data.

For a landscape or battlecard, also read the competitive-research skill when it is enabled. For current news on the account or its sector, also read the news-briefing skill when it is enabled.

## Account brief

- What we know: company, buying context, stakeholders, current state — supplied plus observed.
- Why now: the trigger or timing driver, if evidenced.
- Hypothesized pain, labelled as hypothesis.
- Our wedge: the narrowest place we clearly help.
- Risks: competitive presence, budget, timing, internal blockers.
- Open questions: what is still private (budget, politics, unpublished pricing) and must be confirmed on the call.

## Discovery call prep

- 2–3 hypotheses about the buyer's problem, each falsifiable on the call.
- Prioritized questions: start broad on current state, narrow to impact and quantification, then decision process (economic buyer, criteria, paper process, timing).
- Listen-fors: the specific phrases that confirm or kill each hypothesis.
- Do not use the call to ask what a public filing or homepage already states.
- Keep the list shorter than the call allows. Time to listen is the point.

## Objection handling

For each objection: acknowledge the concern as stated, respond with an approved proof point, then ask a clarifying question that reopens the conversation. Optionally name the proof you would need to fully resolve it.

Do not argue, do not disparage competitors, and do not answer a pricing or legal objection with an invented concession. Competitive claims in an objection need an observed source or they stay off the table.

## Demo script

Audience, duration, products in scope, environment constraints, and the success moment the demo builds toward. Then a timed flow with a talk track and fallback paths for when something does not load or the audience redirects. Lead with the outcome, not the feature tour.

## Proposal

Buyer, problem, scope, approach, timeline, commercial posture, success criteria, and assumptions. Label every assumption. Where pricing or legal terms were not supplied, leave a clearly marked placeholder rather than a number.

## Enablement assets

Confirm audience, format, and approved claims before building. Keep one-pagers to one argument. Internal enablement material should say plainly what is approved to repeat externally and what is not. Battlecards are internal until the user says otherwise.
