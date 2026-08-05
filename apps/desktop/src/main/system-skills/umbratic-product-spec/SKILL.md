---
name: Product Spec
description: Use when drafting a PRD, RFC, design doc, or architecture write-up, for structure, requirement quality, non-goals, acceptance criteria, and an explicit assumptions section.
---

# Product Spec

Structure for PRDs, RFCs, and design docs. Gather missing decisions first; this skill covers what to write once you have them.

## Choosing the document type

- **PRD** — what to build and why, for a product decision. Problem, users, requirements, success metrics.
- **RFC** — a proposal inviting a decision between options. Context, options with trade-offs, recommendation.
- **Design doc** — how to build something already agreed on. Architecture, interfaces, data, migration, risks.

Do not blend all three. If the request is ambiguous, pick the one that matches the decision the reader has to make and say which you chose.

## Standard sections

1. **Summary** — the whole document in three sentences. What, for whom, why now.
2. **Problem** — the observed situation and its cost. Evidence, not assertion.
3. **Goals** — outcomes, not features.
4. **Non-goals** — what this deliberately does not address. A spec without non-goals has no edges.
5. **Requirements** — numbered, testable, each independently checkable.
6. **Design / approach** — for RFCs, the options and trade-offs; for design docs, the mechanism.
7. **Acceptance criteria** — how anyone can verify this shipped correctly.
8. **Risks and open questions** — with owners where known.
9. **Assumptions** — every fact you supplied rather than were given.

## Requirement quality bar

- One requirement per line, numbered for reference.
- Testable: a reader can say whether it is met without asking the author.
- State the behavior and its bound, not the implementation.
- Prefer "must" / "should" / "may" and use them consistently.
- Bad: "The search should be fast." Good: "Warm path lookup must return within 100 ms at p95 on a 50,000-path workspace."

## Acceptance criteria

Write them so they could become tests. Each maps to at least one requirement. Include the negative cases and the degradation path, not only the happy path.

## Assumptions section

Non-negotiable when requirements were incomplete. For each assumption record what you assumed, why, and what changes if it is wrong. Keep it at the top or in its own section — never buried in prose.

## Never

- Invent metrics, user research, or competitive claims to make a section look complete. Write "unknown" and list it as an open question.
- Present an assumption as a given.
- Pad with sections the document does not need.
