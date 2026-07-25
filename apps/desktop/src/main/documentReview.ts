import * as fs from "node:fs";
import * as path from "node:path";

import {
  documentReviewByteLimit,
  documentReviewSidecarPath,
  isDocumentReviewArtifactPath,
  parseDocumentReviewSnapshot,
  type DocumentReviewSnapshot,
} from "../shared/documentReview";
import type { ReviewFile } from "./types";
import { normalizeRelativePath, pathInside } from "./utils";

type DocumentReviewTask = {
  id: string;
  worktreePath: string;
  originalRepoPath: string;
  reviewFiles: ReviewFile[];
};

export type DocumentReviewReadResult =
  | { ok: true; preview: DocumentReviewSnapshot }
  | { ok: false; code: "not_available" | "invalid" | "unsafe" | "too_large"; message: string };

function taskReviewContains(task: DocumentReviewTask, relativePath: string): boolean {
  return task.reviewFiles.some((file) => normalizeRelativePath(file.path) === relativePath);
}

function hasSymlinkComponent(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function readTaskDocumentReview(
  task: DocumentReviewTask,
  requestedDocumentPath: string,
): DocumentReviewReadResult {
  const documentPath = normalizeRelativePath(requestedDocumentPath.trim());
  if (
    !documentPath
    || path.isAbsolute(requestedDocumentPath)
    || !isDocumentReviewArtifactPath(documentPath)
    || !taskReviewContains(task, documentPath)
  ) {
    return { ok: false, code: "not_available", message: "No document preview is available for this file." };
  }
  const sidecarPath = documentReviewSidecarPath(documentPath);
  if (!sidecarPath || !taskReviewContains(task, sidecarPath)) {
    return { ok: false, code: "not_available", message: "This document does not include a review preview." };
  }
  const root = fs.existsSync(task.worktreePath) ? task.worktreePath : task.originalRepoPath;
  const absoluteRoot = path.resolve(root);
  const absoluteSidecar = path.resolve(absoluteRoot, sidecarPath);
  if (!pathInside(absoluteRoot, absoluteSidecar) || hasSymlinkComponent(absoluteRoot, absoluteSidecar)) {
    return { ok: false, code: "unsafe", message: "The document preview path is not trusted." };
  }
  try {
    const stat = fs.statSync(absoluteSidecar);
    if (!stat.isFile()) {
      return { ok: false, code: "invalid", message: "The document preview is not a regular file." };
    }
    if (stat.size > documentReviewByteLimit) {
      return { ok: false, code: "too_large", message: "The document preview is too large to display." };
    }
    const source = fs.readFileSync(absoluteSidecar, "utf8");
    const preview = parseDocumentReviewSnapshot(JSON.parse(source), documentPath);
    return { ok: true, preview };
  } catch {
    return { ok: false, code: "invalid", message: "The document preview is invalid or unreadable." };
  }
}
