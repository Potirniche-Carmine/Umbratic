---
name: Documents
description: Use for local DOCX/Word creation, editing, redlines, comments, polished document design, accessibility checks, and rendered document QA.
---

# Documents Skill (Read, Create, Edit, Redline, Comment)

Use this skill when creating, editing, reviewing, redlining, commenting on, or finalizing local `.docx` / Word documents.

Common document types include memos, proposals, briefs, reports, SOPs, manuals, forms, questionnaires, launch guides, negotiation briefs, reference guides, and customer-facing documents.

## Scope

- This system skill is for local DOCX/Word workflows only. Do not route to Google Docs, native Google Docs APIs, or Google Docs import behavior from this guidance.
- Prefer a DOCX-first workflow with explicit styles, numbering, margins, table geometry, headers, footers, section behavior, and rendered-page QA.
- Use supplied source material as facts. Mark assumptions plainly. Do not invent customer, legal, pricing, compliance, medical, financial, or source claims.
- Keep generated DOCX deliverables under `.umbratic/artifacts/docx/` unless the user requests a specific path. Use `.umbratic/templates/word/` only for supplied or server-selected templates.

## Runtime Contract

- Prefer the configured local DOCX JavaScript authoring runtime when it is available. Use runtime capability guidance injected into the prompt as authoritative.
- Do not install packages, use global dependencies, or rely on undeclared repo-local packages to create a document.
- If the DOCX authoring runtime is missing and the user asked for an actual `.docx`, state the generation gap and provide document-ready structured content.
- If LibreOffice render/export is missing, do not claim visual QA. You may still perform structural checks, but state that rendered-page verification was unavailable.
- Work in normal writable workspace paths. Do not modify managed dependency directories.

## In-App Review Snapshot

When creating or updating a DOCX under `.umbratic/artifacts/docx/`, also write a compact review snapshot beside it using the exact name `<document>.docx.review.json`. Keep the snapshot synchronized with the final visible document text. It is a local review aid, not a deliverable, and must not be linked in the final response.

Use this exact contract:

```json
{
  "schemaVersion": 1,
  "documentPath": ".umbratic/artifacts/docx/proposal.docx",
  "title": "Proposal",
  "blocks": [
    { "id": "title", "style": "title", "text": "Proposal" },
    { "id": "opening", "style": "paragraph", "text": "First sentence. Second sentence." }
  ]
}
```

- `documentPath` must be the repository-relative path of the sibling DOCX.
- Block ids must be unique, stable, and use only letters, numbers, `.`, `_`, `:`, or `-`.
- Supported styles are `title`, `subtitle`, `heading1`, `heading2`, `heading3`, `paragraph`, `bullet`, `numbered`, and `quote`.
- Preserve reading order and visible wording. Put each heading, paragraph, or list item in its own block.
- Include text only. Do not include HTML, formatting instructions, images, URLs, secrets, source notes, or hidden document metadata.
- If the snapshot cannot be kept synchronized, omit it instead of writing stale review text.

## Non-Negotiable Visual QA

You do not know a DOCX is satisfactory until it has been rendered or exported and visually inspected, when the environment supports that.

Before delivering a DOCX, when LibreOffice or another configured document renderer is available:

- Render or export the document to page images or PDF.
- Inspect every page at readable zoom.
- Check for clipping, overlap, missing glyphs, broken tables, bad line wrapping, orphaned headings, awkward page breaks, inconsistent headers/footers, broken lists, and incorrect spacing.
- Fix defects and re-render until the document is clean.

If rendering fails because the renderer is unavailable, deliver only if the document has passed structural checks and state clearly that visual QA could not be completed. If rendering fails for a fixable reason such as path, profile, conversion, or document corruption, fix the render problem before guessing at quality.

Rendered pages, PDFs, logs, and scratch files are QA intermediates. Do not present them as final deliverables unless requested.

## Design Preset Contract

For new DOCX creation and major rewrites, choose a coherent design preset before drafting. For existing-document edit tasks, preserve the original design and apply the smallest local edits that satisfy the request.

Use one of these presets unless the user supplies a template or asks for a different visual system:

- `standard_business_brief`: formal memos, RFI responses, decision memos, board-style briefs, policy notes.
- `compact_reference_guide`: launch guides, negotiation briefs, playbooks, checklists, dense operator references.
- `narrative_proposal`: grants, proposals, persuasive documents, stakeholder narratives.
- `simple_word_default`: plain professional documents where the user values editability and low styling over polish.
- `form_or_questionnaire`: intake forms, surveys, worksheets, checklists, response templates.

Resolve the preset into exact choices before writing:

- Page size, margins, usable width, section behavior, and page breaks.
- Font family, body size, heading ladder, paragraph rhythm, line spacing, and color roles.
- Table style, cell padding, column width logic, borders, header fills, and repeated headers.
- List indents, marker style, numbering definitions, and continuation behavior.
- Header/footer behavior, page numbers, title block, metadata, and source/citation treatment.
- Callout, note box, checklist, form field, caption, and appendix treatment where used.

Do not rely on Word defaults, built-in list quirks, inherited paragraph spacing, or renderer-dependent behavior for values controlled by the design preset. Implement structure through real Word styles, real numbering definitions, explicit table geometry, and deliberate section settings.

## Form Factor Selection

Choose the lightest readable structure for each content unit:

- Prose section: narrative, explanation, background, rationale.
- Lead callout: decision, recommendation, key takeaway, executive summary.
- Numbered steps: sequence, workflow, procedure, implementation path.
- Grouped bullets: loose factors, requirements, considerations, pros/cons.
- Checklist: actions, acceptance criteria, review checks, launch tasks.
- Note box: warnings, constraints, caveats, assumptions.
- Definition list: metadata, key facts, term definitions, role descriptions.
- Table: repeated comparable records, schedules, budgets, matrices, status grids.
- Form layout: fields, response spaces, scales, signatures, questionnaires.
- Source list: citations, references, appendices, evidence notes.

Use tables only for truly tabular information: repeated rows, shared fields, and useful comparison or lookup. Do not use tables to package normal prose. If cells become mini-paragraphs, switch to prose, bullets, steps, checklists, callouts, or appendix material.

Before finalizing, run a table-overuse audit:

- If most cells in a table are sentence- or paragraph-length prose, convert the section.
- If multiple adjacent sections use tables, check whether at least one should become prose, bullets, steps, a callout, or an appendix.
- If a table spans pages, repeat headers and keep column order consistent.

## Creation Workflow

1. Identify the document archetype, audience, purpose, source material, constraints, and final deliverable path.
2. Choose a design preset or follow the supplied template/reference document.
3. Plan the first page, heading ladder, page rhythm, headers/footers, tables, lists, callouts, forms, citations, and appendices.
4. Draft content with factual discipline. Separate known facts from assumptions and questions.
5. Build the DOCX with explicit styles, numbering, table geometry, margins, headers, footers, section behavior, captions, and metadata.
6. Run structural checks.
7. Render/export and inspect every page when available.
8. Patch defects, re-render, and finalize.

## Design Standards

Documents should feel natural, professional, and appropriate to their real-world use. Visual polish should come from strong typography, spacing, hierarchy, alignment, and restraint, not decorative noise.

Design requirements:

- Pick a visual character that fits the task: formal, operational, persuasive, instructional, reference-heavy, or form-based.
- Make the first page intentional: title, subtitle, metadata, context, key takeaway, and opening structure should fit the archetype.
- Use a clear heading ladder. Do not fake headings with bold body paragraphs.
- Avoid dense walls of text unless the document type requires them. Add scan points through headings, bullets, steps, callouts, or tables where useful.
- Use color intentionally for hierarchy and emphasis. Keep serious documents restrained.
- Keep spacing natural between sections, paragraphs, tables, figures, and callouts.
- Avoid large blank layout gaps. If a table or figure pushes to the next page, adjust scale, split cleanly, or move surrounding content.
- Keep captions and visuals together when possible.
- Use page breaks deliberately, especially before appendices, major sections, and signature pages.
- Keep metadata, source notes, and assumptions concise and auditable.

## Style Implementation

- Define and use real styles for Normal, Title, Subtitle, Heading 1, Heading 2, Heading 3, captions, footnotes, callouts, table text, and list text.
- Use real numbering definitions for bullets and numbered lists. Never create fake bullets with manual symbols, hyphens, or newline-separated list items inside one paragraph.
- Wrapped list lines must align under item text, not under the marker.
- Use direct formatting only for deliberate exceptions. Keep exceptions consistent.
- Avoid mixing multiple style systems in one document.
- Preserve source/template styles when editing an existing document unless the user asks for restyling.

## Table Requirements

Tables require deliberate geometry and visual QA.

Use tables for schedules, budgets, RFI/compliance matrices, responsibility grids, comparison matrices, requirements, risks, issue logs, and repeated records.

Table construction rules:

- Set explicit table widths and column widths. Do not rely on equal-width defaults unless the content actually calls for equal widths.
- Use compact columns for item numbers, checkboxes, dates, statuses, scores, and short codes.
- Reserve wider columns for descriptions, notes, evidence, and narrative fields.
- Avoid overly wide tables when a narrower table reads better.
- Use sufficient cell padding so text never sits against borders.
- Allow rows to expand with wrapped content. Do not use fixed row heights that can clip text.
- Use vertical alignment intentionally; centered often works well for short values, while narrative cells usually read best top or center depending on row height.
- Use horizontal alignment based on column type: center dates/statuses/scores/checks, right-align numbers where useful, left-align narrative text.
- Repeat header rows when tables span pages.
- Keep clear spacing above and below tables.
- Use captions when tables are important enough to reference.

Table QA checks:

- No clipped text, pinned text, crowded cells, awkward narrow description columns, or oversized short-value columns.
- Header labels are readable and not unnecessarily rotated.
- Borders, fills, and font weights are consistent.
- Totals, units, dates, and statuses are clear.

## Forms and Questionnaires

Design forms as usable documents, not spreadsheets.

- Use clear labels, response areas, check targets, scales, and section hierarchy.
- Size fields based on expected input length.
- Keep enough whitespace for completion.
- Avoid dense full-grid borders unless a grid is truly the most usable structure.
- Use content controls or clear placeholder text when the runtime supports them.
- Make signature/date/name/title fields obvious and properly spaced.

## Editing and Redlines

When editing an existing DOCX, preserve the original and make minimal, local changes unless the user asks for a rewrite.

- Inspect the document structure before editing: styles, sections, headers/footers, lists, tables, captions, comments, tracked changes, fields, hyperlinks, images, and page layout.
- Prefer precise replacements, targeted insertions, margin comments, and trackable changes over broad rewrites.
- Preserve existing styles, section breaks, headers, footers, numbering, captions, and cross-references unless the requested edit requires changing them.
- Do not rewrite whole paragraphs when a small phrase-level edit would satisfy the request.
- Do not cross out everything and rewrite from scratch unless explicitly requested.
- Put comments near the relevant text. Do not move all feedback to an end note unless asked.
- If restructuring is needed, do it surgically and explain the reason with a comment or concise summary.
- Remove comments or accept/reject tracked changes only when the user explicitly asks to finalize.

## Reviewing Documents

When the user asks for review rather than edits:

- Prioritize issues that affect correctness, risk, clarity, audience fit, legal/compliance exposure, missing evidence, contradictions, and usability.
- Give location-specific feedback when possible.
- Separate must-fix issues from optional polish.
- Do not silently change the document if the user asked only for review.
- If asked to add comments, place them inline or in the margin at the relevant location.

## Accessibility and Metadata

Check accessibility and privacy when relevant:

- Use heading styles in logical order.
- Provide alt text for meaningful images when supported or note the gap.
- Avoid relying on color alone to communicate meaning.
- Keep table headers clear.
- Use descriptive hyperlink text when possible.
- Remove or preserve metadata according to the user's request.
- Redact sensitive text only when explicitly requested and verify redaction is not merely visual masking.

## Visual QA

Render/export QA should verify both aesthetics and correctness:

- Overall document feels coherent, professional, and appropriate for the archetype.
- Title, subtitle, headings, body, lists, tables, callouts, forms, headers, footers, and page numbers render as intended.
- No overlap, clipping, missing glyphs, orphaned headings, broken bullets, broken numbering, or bad page breaks.
- Tables have readable widths, padding, row heights, repeated headers, and sensible alignment.
- Images, diagrams, text boxes, captions, and callouts are positioned cleanly.
- Forms have enough writing space and clear response targets.
- Important content is not hidden outside margins or pushed into invisible areas.
- There are no unintended blank pages.
- Print/export view matches the intended final reading experience.

If defects are found, make focused repairs and re-render. Stop once the document is correct, legible, and polished; do not spend time on minor subjective refinements that do not affect quality.

## Source, PDF, and Attachment Processing

- Keep source notes compact: file name, section/table label, and enough context to audit the value or claim.
- Do not paste large excerpts from source material unless requested.
- For data extracted from PDFs or images, preserve uncertainty and cite the source location when possible.
- Use only supplied or verifiable facts for high-stakes domains.
- If source material conflicts, surface the conflict rather than choosing silently.

## Error Recovery

On the first DOCX runtime or render error:

1. Read the exact error text.
2. Patch the smallest failing block rather than rewriting the document.
3. Retry once with corrected API usage or a simplified feature.
4. If the same capability is unavailable, state the limitation and provide the best structural fallback.

Do not loop indefinitely on similar failures.

## Completion Criteria

Complete only when:

- The requested content or edits are present.
- Structural features are real DOCX constructs where possible: styles, numbering, tables, sections, headers, footers, captions, and comments.
- The document has passed rendered-page QA when rendering is available.
- Any visual QA gap is explicitly stated when rendering is unavailable.
- The final `.docx` is saved under `.umbratic/artifacts/docx/` unless directed otherwise.
- Only the requested final deliverable is presented, not scratch files or QA intermediates.

## Fallbacks

- If the DOCX JavaScript runtime is missing, provide document-ready structured source and state the generation gap.
- If LibreOffice is missing or rendering fails, do not claim visual QA. State the structural checks performed and the render/export gap.

## Final Response

- Summarize only the final user-visible result and any verification gap.
- Link only the final `.docx` deliverable unless the user asks for support files.
- Do not mention builders, page images, logs, intermediate PDFs, or scratch files unless requested.
