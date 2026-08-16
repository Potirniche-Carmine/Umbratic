/**
 * Reads the preview for a file the artifact tool wrote.
 *
 * The old DOCX review read a `.review.json` written beside the document. This
 * asks the engine instead: one `inspect` job, and the outline it returns
 * becomes the preview. That removes the sidecar entirely, which removes the way
 * it went wrong — a second copy of the truth that anything touching the file
 * left stale, and that had to be written for every format we ever added.
 *
 * Previews are cached by the file's size and modification time, so scrolling a
 * review list does not re-open every workbook on every render.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  artifactFormatOf,
  artifactPreviewFromOutline,
  isArtifactPath,
} from "../shared/artifactReview";
import type { DocumentReviewSnapshot } from "../shared/documentReview";
import { runInWorker } from "./artifacts/service";
import { hasSymlinkComponent, normalizeRelativePath, pathInside } from "./utils";

export type ArtifactReviewResult =
  | { ok: true; preview: DocumentReviewSnapshot }
  | { ok: false; code: "not_available" | "invalid" | "unsafe" | "too_large"; message: string };

/** What a file may weigh before a preview is not worth opening it for. */
const previewByteLimit = 64 * 1024 * 1024;
/** A preview is a read; it should never be the slow part of a render. */
const previewTimeoutMs = 20_000;

/** The key already carries the size and mtime, so the entry is just the answer. */
type CacheEntry = { preview: DocumentReviewSnapshot | null };
const cache = new Map<string, CacheEntry>();
/** Enough for a review list; small enough that it never becomes a leak. */
const maxCacheEntries = 64;

type ReviewTask = {
  worktreePath: string;
  originalRepoPath: string;
};

export async function readArtifactPreview(
  task: ReviewTask,
  requestedPath: string,
): Promise<ArtifactReviewResult> {
  const relative = normalizeRelativePath(requestedPath.trim());
  if (!relative || path.isAbsolute(requestedPath) || !isArtifactPath(relative)) {
    return {
      ok: false,
      code: "not_available",
      message: "No preview is available for this file.",
    };
  }
  const format = artifactFormatOf(relative);
  if (!format) {
    return { ok: false, code: "not_available", message: "No preview is available for this file." };
  }

  const root = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relative);
  // The same confinement the runner applies to a tool path: inside the
  // workspace, and reached without following a symlink out of it.
  if (!pathInside(absoluteRoot, absolute) || hasSymlinkComponent(absoluteRoot, absolute)) {
    return { ok: false, code: "unsafe", message: "The preview path is not trusted." };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { ok: false, code: "not_available", message: "The file is no longer there." };
  }
  if (!stat.isFile()) {
    return { ok: false, code: "invalid", message: "The preview target is not a regular file." };
  }
  if (stat.size > previewByteLimit) {
    return { ok: false, code: "too_large", message: "The file is too large to preview." };
  }

  const key = `${absolute}:${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(key);
  if (cached) {
    return cached.preview
      ? { ok: true, preview: cached.preview }
      : { ok: false, code: "invalid", message: "The file could not be read for a preview." };
  }

  const response = await runInWorker(
    {
      action: "inspect",
      format,
      absolutePath: absolute,
      path: relative,
      workspaceRoot: absoluteRoot,
    },
    previewTimeoutMs,
  );
  if (!response.ok) {
    remember(key, null);
    return {
      ok: false,
      code: "invalid",
      message: response.errors[0]?.message ?? "The file could not be read for a preview.",
    };
  }
  const preview = artifactPreviewFromOutline(relative, format, response.outline);
  remember(key, preview);
  if (!preview) {
    return { ok: false, code: "invalid", message: "The file has nothing to preview." };
  }
  return { ok: true, preview };
}

function remember(key: string, preview: DocumentReviewSnapshot | null): void {
  if (cache.size >= maxCacheEntries) {
    // Oldest first; insertion order is what Map iteration gives us.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { preview });
}

/** Drops every cached preview. Used when a task's workspace is replaced. */
export function clearArtifactPreviewCache(): void {
  cache.clear();
}
