---
name: Discovery
description: Use before drafting a spec, campaign, proposal, or other deliverable when decision-critical inputs are missing, to ask one tight batch of questions instead of drip-feeding them, looking up public facts with web tools rather than asking the user for them.
---

# Discovery

Ask once, ask well, then build. The goal is a working brief, not an interview.

## When to ask at all

Ask only for facts that can change the output you were asked for.

- **Blocker** — you cannot produce a correct deliverable without it. Ask. If `web_search` and `web_fetch` are in the tools array, a public fact is not a blocker: look it up, then ask only for what is still private (budget, unpublished pricing, forbidden claims, internal metrics, stakeholder politics, what is approved to say).
- **Nice-to-have** — it would sharpen the result but a stated assumption covers it. Do not ask; assume and label.
- **Irrelevant** — it cannot change this deliverable. Never ask.

If the supplied brief, source material, fetched public pages, and requested outcome are already sufficient, skip discovery entirely and produce the deliverable. A ceremonial question batch on a complete brief is a failure, not diligence.

## How to ask

- One batch, typically 4–8 questions. Prefer a single well-aimed round over several small rounds.
- Group by theme and number them so the user can answer inline.
- Make each question answerable in a sentence. No compound questions.
- Where you have a sensible default, state it in the question so a busy user can reply "all defaults".
- Say what you will do once answered, so the batch reads as progress rather than delay.

## What to cover

Pick only the categories that apply to the requested deliverable:

- **Goal** — what decision or outcome this serves, and what "done" looks like.
- **Audience** — who reads or uses it, and what they already know.
- **Constraints** — timeline, budget, platform, legal or brand limits, things that are off the table.
- **Success criteria** — how the result will be judged or measured.
- **Inputs** — source material, data, prior art, systems of record.
- **Out of scope** — what to deliberately leave out.
- **Format** — the artifact type, length, and where it will live.

## If answers are partial

Ask only the remaining blockers. Do not re-ask what was answered, and do not restate the whole batch.

## If the user says "just draft it"

Proceed immediately. State your assumptions explicitly at the top of the draft, keep them few and load-bearing, and flag the ones most likely to be wrong so they are easy to correct.

## Never

- Invent facts, metrics, customer quotes, or firmographics to fill a gap. An unknown stays an unknown, labelled as one. Training data is not a live source.
- Stall a deliverable on a question whose answer would not change it.
- Ask the user for a fact a public page already states when the web tools are present.
