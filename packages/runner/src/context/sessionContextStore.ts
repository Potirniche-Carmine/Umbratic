import * as crypto from "node:crypto";

import { clipUtf8Bytes, contextCompressionLimits, utf8ByteLength, type ContextCompressionStrategy, type ContextContentKind } from "./types.js";

export type StoredContextEntry = {
  hash: string;
  fullHash: string;
  toolCallId: string;
  toolName: string;
  title: string;
  original: string;
  compressed: string;
  kind: ContextContentKind;
  strategy: ContextCompressionStrategy;
  originalBytes: number;
  storedBytes: number;
  compressedBytes: number;
  originalTruncated: boolean;
  createdAtMs: number;
  retrievalCount: number;
};

export type RetrievedContextWindow = {
  entry: StoredContextEntry;
  offset: number;
  bytesShown: number;
  totalBytes: number;
  content: string;
  nextOffset?: number;
};

export function contextHash(value: string): { hash: string; fullHash: string } {
  const fullHash = crypto.createHash("sha256").update(value).digest("hex");
  return { fullHash, hash: fullHash.slice(0, 24) };
}

function normalizeWindow(input: { offset?: number; limit?: number } | undefined, totalBytes: number): { offset: number; limit: number } {
  const offset = Math.min(
    totalBytes,
    Math.max(0, Number.isFinite(input?.offset) ? Math.floor(input?.offset ?? 0) : 0),
  );
  const requestedLimit = Number.isFinite(input?.limit) ? Math.floor(input?.limit ?? 0) : contextCompressionLimits.retrievalDefaultBytes;
  const limit = Math.min(
    contextCompressionLimits.retrievalMaxBytes,
    Math.max(1, requestedLimit > 0 ? requestedLimit : contextCompressionLimits.retrievalDefaultBytes),
  );
  return { offset, limit };
}

function sliceUtf8Window(value: string, offset: number, limit: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer
    .subarray(offset, Math.min(buffer.length, offset + limit))
    .toString("utf8")
    .replace(/^\uFFFD|\uFFFD$/gu, "");
}

export class SessionContextStore {
  private readonly entries = new Map<string, StoredContextEntry>();

  store(input: Omit<StoredContextEntry, "hash" | "fullHash" | "createdAtMs" | "retrievalCount" | "storedBytes" | "originalTruncated">): StoredContextEntry {
    this.expire();
    const { hash, fullHash } = contextHash(input.original);
    const existing = this.entries.get(hash);
    if (existing && existing.fullHash !== fullHash) {
      throw new Error(`Context hash collision for ${hash}`);
    }

    const originalBytes = utf8ByteLength(input.original);
    const storedOriginal = clipUtf8Bytes(input.original, contextCompressionLimits.maxStoredOriginalBytes);
    const entry: StoredContextEntry = {
      ...input,
      hash,
      fullHash,
      original: storedOriginal,
      originalBytes,
      storedBytes: utf8ByteLength(storedOriginal),
      compressedBytes: utf8ByteLength(input.compressed),
      originalTruncated: originalBytes > utf8ByteLength(storedOriginal),
      createdAtMs: Date.now(),
      retrievalCount: existing?.retrievalCount ?? 0,
    };

    if (!existing) {
      while (this.entries.size >= contextCompressionLimits.maxEntriesPerSession) {
        const oldestHash = this.entries.keys().next().value as string | undefined;
        if (!oldestHash) break;
        this.entries.delete(oldestHash);
      }
    }
    this.entries.set(hash, entry);
    return entry;
  }

  retrieve(hash: string, options?: { offset?: number; limit?: number }): RetrievedContextWindow | null {
    this.expire();
    const entry = this.entries.get(hash);
    if (!entry) return null;
    entry.retrievalCount += 1;
    const totalBytes = entry.storedBytes;
    const { offset, limit } = normalizeWindow(options, totalBytes);
    const content = sliceUtf8Window(entry.original, offset, limit);
    const bytesShown = utf8ByteLength(content);
    return {
      entry,
      offset,
      bytesShown,
      totalBytes,
      content,
      ...(offset + bytesShown < totalBytes ? { nextOffset: offset + bytesShown } : {}),
    };
  }

  hasEntries(): boolean {
    this.expire();
    return this.entries.size > 0;
  }

  stats(): { entries: number; storedBytes: number } {
    this.expire();
    let storedBytes = 0;
    for (const entry of this.entries.values()) {
      storedBytes += entry.storedBytes;
    }
    return { entries: this.entries.size, storedBytes };
  }

  private expire() {
    const cutoff = Date.now() - contextCompressionLimits.ttlMs;
    for (const [hash, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) this.entries.delete(hash);
    }
  }
}
