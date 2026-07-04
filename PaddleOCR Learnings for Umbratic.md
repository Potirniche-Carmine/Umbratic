---
title: PaddleOCR Learnings for Umbratic
tags:
  - umbratic
  - ocr
  - document-ai
status: draft
source_date: 2026-07-03
---

# PaddleOCR Learnings for Umbratic

## Scope

This note compares the local [PaddleOCR](../PaddleOCR/) repo with [UmbraticAI](../UmbraticAI/) and extracts the parts worth implementing in Umbratic.

The recommendation is not to import PaddleOCR wholesale. PaddleOCR is a full OCR and Document AI ecosystem: training code, many detection and recognition models, layout parsing, tables, formulas, seals, chart parsing, service deployment, hosted API SDKs, browser SDKs, benchmarks, and docs. Umbratic needs a much smaller feature: a local, private, auditable OCR preprocessing layer for attached images and scanned PDFs.

## Executive Takeaway

PaddleOCR does well because it treats OCR as a document pipeline, not as a single vision prompt.

The useful sequence is:

1. Render or load a page image.
2. Normalize the page under bounded size limits.
3. Detect text regions.
4. Convert regions into clean perspective-corrected crops.
5. Optionally fix text-line orientation.
6. Batch recognition efficiently.
7. Filter by confidence.
8. Restore reading order.
9. Persist text, coordinates, confidence, page numbers, and timing.
10. Use structured outputs, especially JSON and Markdown, as the LLM-facing artifact.

UmbraticAI already has the right place to host this: its local artifact and attachment runtime. It renders PDF attachments to images, accepts image prompt parts, probes optional artifact capabilities, injects runtime guidance, and keeps generated artifacts under `.umbratic/artifacts`. OCR should become another optional local artifact capability, not a new public connector or hosted service.

## What PaddleOCR Does Well

### 1. It Keeps OCR Modular

Paddle's general OCR pipeline is explicitly composed from independent modules:

- Document image orientation classification.
- Text image unwarping.
- Text line orientation classification.
- Text detection.
- Text recognition.

That modularity matters more than the exact models. In [OCR.en.md](../PaddleOCR/docs/version3.x/pipeline_usage/OCR.en.md), each module can be toggled, replaced, or fine-tuned independently. The low-level implementation mirrors this in [predict_system.py](../PaddleOCR/tools/infer/predict_system.py): `TextSystem` creates `TextDetector`, `TextRecognizer`, and optionally `TextClassifier`.

Umbratic lesson: expose OCR as a small pipeline with feature flags, not a monolith. The initial Umbratic version can disable document unwarping, advanced layout, formulas, and table reconstruction while still preserving the pipeline contract.

### 2. It Uses Geometry Before Language

Paddle does not send a whole image directly to a recognizer. Detection first produces polygons or quadrilateral boxes. Recognition only runs on cropped text lines.

Key implementation details:

- [predict_det.py](../PaddleOCR/tools/infer/predict_det.py) preprocesses images with resize, normalization, CHW conversion, and original shape retention.
- DB detection defaults are practical starting points: `det_db_thresh=0.3`, `det_db_box_thresh=0.6`, `det_db_unclip_ratio=1.5`, `det_limit_side_len=960`, `det_limit_type=max`.
- [db_postprocess.py](../PaddleOCR/ppocr/postprocess/db_postprocess.py) turns probability maps into contours, scores boxes, expands them with `unclip`, drops tiny boxes, clips to image bounds, and returns points.
- `filter_tag_det_res` orders points clockwise, clips them to the source image, and removes boxes with width or height at or below 3 pixels.

Umbratic lesson: the core output should be line records with `polygon`, `bbox`, `text`, `confidence`, `pageNumber`, and `order`. Plain text alone is not enough for review, citations, or debugging.

### 3. It Normalizes Crops Carefully

[utility.py](../PaddleOCR/tools/infer/utility.py) has two crop paths:

- `get_rotate_crop_image` uses a perspective transform to turn a quadrilateral into a rectangular text-line crop.
- `get_minarea_rect_crop` uses OpenCV's min-area rectangle for polygon-like detections.

It also rotates tall crops when the height-to-width ratio suggests the crop is vertical. This is small but important: OCR quality is often won or lost between detection and recognition.

Umbratic lesson: if Umbratic implements any custom OCR code, it should copy the idea of perspective-corrected crop normalization, not naive rectangular clipping. If it uses a packaged local OCR engine, the Umbratic result contract should still preserve source polygons.

### 4. It Sorts for Human Reading Order

`sorted_boxes` in [predict_system.py](../PaddleOCR/tools/infer/predict_system.py) sorts detected boxes top-to-bottom, then left-to-right, with a row tolerance. This simple ordering makes OCR text usable as a document digest.

PP-StructureV3 goes further with layout block ordering. Its output includes `block_id` and `block_order` for reading order recovery, and it can produce Markdown.

Umbratic lesson: every OCR digest should include both:

- A simple line order for general text.
- A future layout/block order for multi-column or table-like pages.

For the first implementation, use Paddle's simple line-order idea and add a warning when a page looks multi-column or table-heavy.

### 5. It Batches Recognition by Aspect Ratio

[predict_rec.py](../PaddleOCR/tools/infer/predict_rec.py) computes the width/height ratio for every crop, sorts crops by ratio, batches similar crops together, then restores original order after decoding.

This is a high-leverage performance trick because OCR line crops have wildly different widths. Batching similar shapes reduces padding waste and improves throughput.

Umbratic lesson: if the engine allows batching, batch line crops by aspect ratio. Even if Umbratic uses a library for inference, keep this as an evaluation criterion for engine choice.

### 6. It Treats Confidence as First-Class Data

Paddle's CTC decoder in [rec_postprocess.py](../PaddleOCR/ppocr/postprocess/rec_postprocess.py) computes text confidence from per-character probabilities, removes duplicate CTC tokens, removes blank tokens, and can return word-level metadata. `TextSystem` then applies `drop_score`, defaulting to `0.5`.

Paddle's newer pipeline docs also describe `text_rec_score_thresh`, `rec_texts`, `rec_scores`, and `rec_polys` as output fields.

Umbratic lesson: OCR output must carry confidence and preserve uncertainty. Low-confidence lines should not silently disappear unless the user asked for clean text only. The LLM should see something like `[low confidence 0.42]` when a value matters.

### 7. It Has Practical Page and Slice Handling

Paddle handles multi-page inputs and extreme aspect ratios:

- PDFs are processed page by page.
- Very tall or wide images can be sliced with overlap and merged afterward.
- `slice_generator` guards against too many slices and recommends a larger stride.

Umbratic already has similar instincts in [main.ts](../UmbraticAI/apps/desktop/src/main/main.ts): PDF attachment rendering is bounded by byte limit, page limit, scale, timeout, and a temporary directory.

Umbratic lesson: OCR should follow the existing bounded-worker pattern. Do not OCR an unbounded document. Use explicit page limits, byte limits, scale, timeout, and cleanup.

### 8. It Produces LLM-Friendly Artifacts

Paddle's current product direction is strongly aligned with LLM workflows. The local README describes structured Markdown and JSON outputs, PP-StructureV3 conversion to Markdown, and PaddleOCR-VL output as Markdown/JSON.

PP-StructureV3 output fields worth borrowing conceptually:

- `layout_det_res`
- `overall_ocr_res`
- `block_bbox`
- `block_label`
- `block_content`
- `block_id`
- `block_order`
- `table_res_list`
- `formula_res_list`
- `markdown`
- `outputImages`

Umbratic lesson: OCR should not only inject text into the prompt. It should write durable artifacts:

- `source.ocr.json` for coordinates, confidence, metrics, and warnings.
- `source.ocr.md` for the LLM and user-facing digest.
- Optional debug overlay images only when requested or when reviewing extraction quality.

### 9. It Separates Core and Optional Capability

PaddleOCR's README explicitly calls out separated core and optional dependencies: basic text recognition can stay smaller, while document parsing and information extraction dependencies are optional.

Umbratic lesson: OCR should be capability-gated like PDF, DOCX, PPTX, and XLSX support. Basic OCR should not imply table recognition, formula recognition, chart parsing, or a document VLM.

### 10. It Offers Multiple Deployment Shapes

Relevant Paddle deployment shapes:

- Python/Paddle inference for the full stack.
- ONNX Runtime and OpenVINO for performance-oriented local inference.
- PaddleOCR.js for browser-side ONNX Runtime Web plus OpenCV.js.
- Hosted API TypeScript SDK for Paddle's official services.

For Umbratic:

- The hosted API SDK is not a fit because Umbratic's product boundary is private and local.
- Full Python PaddleOCR is likely too heavy for a first pass.
- PaddleOCR.js is worth evaluating as a local engine adapter, but only if model assets are bundled or admin-managed and no runtime model download is required.
- A narrow ONNX/OpenCV worker that implements the Paddle-like contract may be the cleanest long-term product shape.

## UmbraticAI Current State

### Product Boundary

[UmbraticAI README](../UmbraticAI/README.md) defines Umbratic as a private AI workbench. The intended path is:

```text
Electron desktop app
  -> local runner on 127.0.0.1
    -> Veil authenticated model boundary
      -> private Ollama or vLLM runtime
  -> local workspace files and commands
  -> local ~/.umbratic/skills
  -> optional local document artifact runtime
```

The same README places web search, browser automation, public connectors, public model passthrough, and public marketplaces out of scope.

OCR therefore belongs in local desktop/runtime code, not in a hosted OCR API.

### Existing Attachment and Vision Path

[main.ts](../UmbraticAI/apps/desktop/src/main/main.ts) already handles attachments:

- Text files are read directly up to `512 KB`.
- Images are passed as `data:image/...` prompt parts up to `10 MB`.
- PDFs are rendered to images up to `25 MB`, first `12` pages, scale `1.4`, timeout `30s`.
- Rendered PDF pages are passed as image prompt parts.
- Temporary PDF render directories are cleaned up.

[pdfRendererWorker.ts](../UmbraticAI/apps/desktop/src/main/pdfRendererWorker.ts) isolates PDF rendering in a worker process and validates page limit, scale, and byte limit.

[packages/runner/src/loop.ts](../UmbraticAI/packages/runner/src/loop.ts) converts image prompt parts into `image_url` content for model APIs that support vision. [Veil](../UmbraticAI/infrastructure/veil/internal/policy/request.go) accepts `image_url` message parts.

This is useful, but it means current scanned-PDF/image understanding depends on the model's vision capability. There is no deterministic local OCR digest yet.

### Existing Artifact Capability Pattern

[artifactRuntime.ts](../UmbraticAI/apps/desktop/src/main/artifactRuntime.ts) and [capabilities.ts](../UmbraticAI/apps/desktop/src/main/capabilities.ts) already define optional artifact probes and prompt guidance:

- PDF extraction with `pdfplumber`/`pypdf`.
- PDF rendering with Poppler.
- `pdf-to-img` for image input to vision models.
- DOCX/PPTX/XLSX authoring and rendering probes.
- System skill capability guidance for PDF/document/presentation/spreadsheet workflows.

OCR should follow this shape:

- Add optional OCR capability probes.
- Add an OCR system skill.
- Add prompt guidance only when the user asks for OCR-like work or attaches image/PDF inputs.
- Store outputs under `.umbratic/artifacts/ocr/`.

### Dependency and Supply-Chain Constraints

[check-supply-chain.mjs](../UmbraticAI/scripts/check-supply-chain.mjs) requires exact dependency versions or local workspace specs, `.npmrc` guardrails, a 24-hour release-age policy, and a small allowScripts list.

OCR dependencies must respect this. Do not add broad install-time scripts, network model downloads, or floating dependency ranges.

## What Umbratic Should Borrow

Borrow these concepts:

- A modular pipeline with independently optional stages.
- Bounded page/image preprocessing.
- Detector-recognizer separation.
- Geometry-preserving line records.
- Perspective-corrected crop handling.
- Aspect-ratio-aware batching.
- Confidence thresholds and low-confidence surfacing.
- Stable reading order.
- JSON and Markdown outputs.
- Runtime capability gates.
- Benchmark metrics and redacted telemetry.

Do not borrow these initially:

- Full Paddle training stack.
- All recognition algorithms and decoders.
- PP-StructureV3's full table/formula/seal/chart pipeline.
- PaddleOCR-VL document VLM.
- Hosted PaddleOCR API SDK.
- Runtime downloads from public model stores.
- Public service deployment.
- Global language/model management for 100+ languages.

## Proposed Umbratic OCR Output Contract

Use a small engine-neutral contract so Umbratic can swap engines later.

```ts
type OcrDocument = {
  schemaVersion: 1;
  source: {
    pathLabel: string;
    kind: "image" | "pdf";
    sha256?: string;
    pageCount?: number;
  };
  engine: {
    id: "paddleocr-js" | "paddle-onnx-worker" | "tesseract" | "none";
    version?: string;
    model?: string;
    localOnly: true;
  };
  settings: {
    pageLimit: number;
    imageScale?: number;
    textDetThresh?: number;
    textDetBoxThresh?: number;
    textDetUnclipRatio?: number;
    textRecScoreThresh: number;
  };
  pages: OcrPage[];
  warnings: OcrWarning[];
  metrics: {
    totalMs: number;
    renderedPages?: number;
    detectedBoxes: number;
    recognizedLines: number;
    averageConfidence?: number;
  };
};

type OcrPage = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  lines: OcrLine[];
};

type OcrLine = {
  order: number;
  text: string;
  confidence: number;
  polygon: [number, number][];
  bbox: [number, number, number, number];
  lowConfidence?: boolean;
};

type OcrWarning =
  | { code: "page_limit_reached"; message: string }
  | { code: "low_confidence"; message: string }
  | { code: "multi_column_suspected"; message: string }
  | { code: "engine_missing"; message: string }
  | { code: "render_failed"; message: string };
```

Markdown output should be simple:

```markdown
# OCR: source.pdf

> Source: source.pdf
> Engine: paddle-onnx-worker, local only
> Pages processed: 3 of 12
> Average confidence: 0.91

## Page 1

Recognized text in reading order...

## Low-Confidence Lines

- Page 2, line 14, confidence 0.43: `...`
```

## Best Fit For Umbratic

The first useful Umbratic feature is not "PaddleOCR inside Umbratic." It is "Paddle-like OCR digest generation for local attachments."

Use OCR when:

- The user asks to read text from an image, screenshot, scan, or PDF.
- A PDF has poor or empty embedded text extraction.
- The user asks for source-grounded extraction, comparison, form fields, or document QA from a scanned source.
- A vision model is unavailable or should be avoided for private/local deterministic preprocessing.

Do not use OCR when:

- The PDF has clean embedded text and no layout/scan issues.
- The user asks about purely visual content, diagrams, pictures, or charts that require visual reasoning.
- The OCR capability is missing and the prompt can be answered by normal text/file tools.

## Strategic Recommendation

Implement OCR as a local optional artifact pipeline in the desktop app:

- Start with image and scanned-PDF text OCR.
- Preserve coordinates and confidence.
- Generate Markdown and JSON artifacts.
- Feed the Markdown digest into the runner prompt.
- Keep raw images as optional vision prompt parts only when needed.
- Keep the engine replaceable behind a small `OcrEngine` interface.

This gives Umbratic most of PaddleOCR's practical value for the current product while avoiding the weight of PaddleOCR's full codebase.

## Sources Inspected

- [PaddleOCR README](../PaddleOCR/README.md)
- [General OCR pipeline docs](../PaddleOCR/docs/version3.x/pipeline_usage/OCR.en.md)
- [PP-StructureV3 pipeline docs](../PaddleOCR/docs/version3.x/pipeline_usage/PP-StructureV3.en.md)
- [Text system pipeline](../PaddleOCR/tools/infer/predict_system.py)
- [Text detector](../PaddleOCR/tools/infer/predict_det.py)
- [Text recognizer](../PaddleOCR/tools/infer/predict_rec.py)
- [Text classifier](../PaddleOCR/tools/infer/predict_cls.py)
- [Inference utilities](../PaddleOCR/tools/infer/utility.py)
- [DB postprocess](../PaddleOCR/ppocr/postprocess/db_postprocess.py)
- [Recognition postprocess](../PaddleOCR/ppocr/postprocess/rec_postprocess.py)
- [PaddleOCR.js architecture](../PaddleOCR/paddleocr-js/docs/architecture.md)
- [PaddleOCR.js package README](../PaddleOCR/paddleocr-js/packages/core/README.md)
- [PaddleOCR TypeScript SDK README](../PaddleOCR/api_sdk/typescript/README.md)
- [UmbraticAI README](../UmbraticAI/README.md)
- [UmbraticAI artifact runtime](../UmbraticAI/apps/desktop/src/main/artifactRuntime.ts)
- [UmbraticAI capabilities](../UmbraticAI/apps/desktop/src/main/capabilities.ts)
- [UmbraticAI main attachment handling](../UmbraticAI/apps/desktop/src/main/main.ts)
- [UmbraticAI PDF render worker](../UmbraticAI/apps/desktop/src/main/pdfRendererWorker.ts)
- [UmbraticAI runner loop](../UmbraticAI/packages/runner/src/loop.ts)
- [UmbraticAI supply-chain check](../UmbraticAI/scripts/check-supply-chain.mjs)
