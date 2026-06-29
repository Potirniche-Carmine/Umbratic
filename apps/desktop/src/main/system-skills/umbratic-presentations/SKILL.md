---
name: Presentations
description: Use for local PowerPoint/PPTX creation, editing, slide copy, speaker notes, export checks, and customer-facing decks.
---

# Presentations

## When To Use

- Create, edit, or review local `.pptx` PowerPoint decks.
- Produce deck-ready outlines, slide copy, speaker notes, proposals, board decks, sales decks, and customer-facing presentations.
- Verify exported slides visually before delivery when the render/export path is available.

## Scope

- This system skill is for local PowerPoint/PPTX workflows only. Do not route to Google Slides, browser automation, or native Google Slides APIs from this guidance.
- If the user supplies an existing `.pptx`, preserve its typography, palette, master/layout intent, page markers, footers, and brand chrome unless they ask for a restyle.
- If no template is supplied, create a clean local presentation from scratch using the configured PPTX JavaScript artifact runtime when available.

## Authoring Workflow

1. Define the audience, objective, narrative arc, slide sequence, and decision or action the deck should support.
2. Keep slide copy concise. Move detail to speaker notes, backup slides, or appendices instead of cramming dense prose onto slides.
3. Use one coherent visual system across the deck: consistent title placement, margins, type scale, color roles, image treatment, and footer/page-marker behavior.
4. Prefer native PowerPoint shapes, tables, charts, image placeholders, and text boxes produced by the configured JS runtime. Do not use ad hoc `python-pptx` for net-new decks.
5. Ground claims in supplied source material. Do not invent customer metrics, logos, case studies, pricing, dates, legal promises, or competitive claims.

## Layout Standards

- Use generous margins and stable slide geometry. Avoid nested-card dashboards, cramped grids, and low-value decorative panels unless the user requests that style.
- Titles should not wrap unintentionally. Shorten text before shrinking below readable size.
- Check every slide for overlap, clipped text, broken connectors, inconsistent alignment, distorted images, orphaned labels, and unresolved placeholders.
- Use diagrams only when they materially clarify the message. Keep connectors behind nodes and route them so they do not cross labels.
- Use each major visual asset deliberately. Do not repeat the same image across multiple slides unless it is part of a deliberate background or template system.

## Paths And QA

- Keep generated PPTX deliverables under `.umbratic/artifacts/pptx/` unless the user requests a specific path.
- Use `.umbratic/templates/powerpoint/` only for supplied or server-selected templates.
- Export or render the final deck with LibreOffice when available, inspect every slide image or contact sheet, then fix and re-export until the deck is clean.
- Do not claim slide render/export QA unless the export output was actually produced and inspected. If the PPTX runtime or LibreOffice is missing, provide deck-ready source or state the exact generation or QA gap.
