/**
 * Fetches catalog weights, verifies them, and reports progress.
 *
 * Main-process only. The renderer names a catalog id and watches a progress
 * channel; it never sees a URL, a file path, or a filesystem error, because
 * none of those are its to know or to act on.
 *
 * A file downloads as parallel byte ranges: the CDN throttles per connection,
 * so several ranges land in a fraction of one stream's time. Finished ranges
 * are recorded in a sidecar, which is what makes a cancelled or interrupted
 * transfer resume from what it has instead of starting over.
 *
 * A download is not trusted because it completed. The assembled file is read
 * back through SHA-256 and compared against the digest recorded in the
 * catalog before it is allowed to take its final name — so a truncated
 * transfer, a corrupted cache, or a substituted file all end the same way:
 * deleted, and reported as an error.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";

import { modelsDirectory } from "./appPaths";
import { catalogFileUrl, type CatalogFile, type CatalogModel, type CatalogQuant } from "./modelCatalog";

export type ModelDownloadState = "downloading" | "verifying" | "done" | "cancelled" | "error";

export type ModelDownloadEvent = {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  state: ModelDownloadState;
};

export type ModelDownloadListener = (event: ModelDownloadEvent) => void;

const listeners = new Set<ModelDownloadListener>();
// One at a time. Two multi-gigabyte transfers over one connection finish later
// than the same two in sequence, and the second one's progress bar spends its
// life at a standstill.
let active: { id: string; abort: AbortController } | null = null;

export function onModelDownloadEvent(listener: ModelDownloadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: ModelDownloadEvent): void {
  for (const listener of listeners) listener(event);
}

export function modelDirectory(dataRoot: string, model: CatalogModel): string {
  // A discovered model names its own directory: its files were put there by
  // hand, under whatever name the person who put them there chose.
  return model.localDirectory ?? path.join(modelsDirectory(dataRoot), model.id);
}

export function modelFilePath(dataRoot: string, model: CatalogModel, file: CatalogFile): string {
  return path.join(modelDirectory(dataRoot, model), file.name);
}

/** Chat can run without its optional vision encoder; speech and image need every component. */
export function modelDownloaded(dataRoot: string, model: CatalogModel, quant: CatalogQuant): boolean {
  return quant.files.filter((file) => model.kind !== "chat" || !/^mmproj-/i.test(file.name)).every((file) => {
    const stat = fs.statSync(modelFilePath(dataRoot, model, file), { throwIfNoEntry: false });
    return stat?.isFile() === true && stat.size === file.bytes;
  });
}

export function modelFileDownloaded(dataRoot: string, model: CatalogModel, file: CatalogFile): boolean {
  const stat = fs.statSync(modelFilePath(dataRoot, model, file), { throwIfNoEntry: false });
  return stat?.isFile() === true && stat.size === file.bytes;
}

export function downloadingModelId(): string | null {
  return active?.id ?? null;
}

/** Called from before-quit. A partial file is left on disk on purpose: the next attempt resumes from it. */
export function abortModelDownloads(): void {
  active?.abort.abort();
  active = null;
}

export function cancelModelDownload(id: string): void {
  if (active?.id !== id) return;
  active.abort.abort();
}

function bytesOnDisk(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * One GET that follows Hugging Face's redirect to its CDN.
 *
 * Redirects are followed by hand rather than by a client library so the rules
 * stay visible: HTTPS only, a bounded chain, and the Range header carried
 * across so a resume is still a resume after the hop.
 */
function get(url: string, headers: Record<string, string>, signal: AbortSignal, hops = 0): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error("The download was redirected too many times."));
      return;
    }
    const request = https.get(url, { headers, signal }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const next = new URL(location, url);
        if (next.protocol !== "https:") {
          reject(new Error("The download was redirected to an insecure address."));
          return;
        }
        resolve(get(next.toString(), headers, signal, hops + 1));
        return;
      }
      if (status !== 200 && status !== 206) {
        response.resume();
        reject(new Error(`The download failed with status ${status}.`));
        return;
      }
      resolve(response);
    });
    request.once("error", reject);
  });
}

// Eight ranges in flight — what hf_transfer and aria2 settle on — cut a large
// transfer to a fraction of one stream's time: the CDN caps each connection
// well below what a home link carries, so the download scales with the
// connection count until the link itself is full. 48 MB per range keeps the
// resume sidecar coarse enough to stay tiny.
const rangeConnections = 8;
const rangeBytes = 48 * 1024 * 1024;

type ChunkLedger = { bytes: number; rangeBytes: number; done: number[] };

/** Which ranges of the partial file have fully landed, or null to start over. */
function readChunkLedger(ledgerPath: string, file: CatalogFile): ChunkLedger | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as ChunkLedger;
    if (parsed.bytes !== file.bytes || parsed.rangeBytes !== rangeBytes) return null;
    if (!Array.isArray(parsed.done) || parsed.done.some((index) => !Number.isInteger(index) || index < 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAt(fd: number, chunk: Buffer, position: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.write(fd, chunk, 0, chunk.byteLength, position, (cause) => cause ? reject(cause) : resolve());
  });
}

/** The whole assembled file, read back off disk — verify what will be kept. */
function fileDigest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Downloads one file into `<name>.partial` as parallel ranges, then verifies
 * the digest and renames it into place.
 *
 * The ledger beside the partial records which ranges are complete, so a
 * cancelled or failed transfer resumes with only the ranges it is missing. A
 * server that answers a range request with the whole file gets one sequential
 * stream instead — slower, never wrong.
 */
async function downloadFile(
  dataRoot: string,
  model: CatalogModel,
  file: CatalogFile,
  signal: AbortSignal,
  onProgress: (received: number) => void,
  onVerifying: () => void,
): Promise<void> {
  const finalPath = modelFilePath(dataRoot, model, file);
  const partialPath = `${finalPath}.partial`;
  const ledgerPath = `${partialPath}.chunks`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  const url = catalogFileUrl(model, file);
  const chunkCount = Math.max(1, Math.ceil(file.bytes / rangeBytes));
  const chunkSize = (index: number) => Math.min(file.bytes, (index + 1) * rangeBytes) - index * rangeBytes;
  const ledger = fs.existsSync(partialPath) ? readChunkLedger(ledgerPath, file) : null;
  const done = new Set<number>(ledger?.done.filter((index) => index < chunkCount) ?? []);
  if (!ledger) fs.rmSync(partialPath, { force: true });

  const fd = fs.openSync(partialPath, fs.existsSync(partialPath) ? "r+" : "w+");
  try {
    let landedBytes = [...done].reduce((total, index) => total + chunkSize(index), 0);
    const inFlight = new Map<number, number>();
    const report = () =>
      onProgress(landedBytes + [...inFlight.values()].reduce((total, received) => total + received, 0));

    const pending = Array.from({ length: chunkCount }, (_, index) => index).filter((index) => !done.has(index));
    let rangeUnsupported = false;

    const fetchChunk = async (index: number) => {
      const start = index * rangeBytes;
      const end = Math.min(file.bytes, start + rangeBytes) - 1;
      const response = await get(url, { Range: `bytes=${start}-${end}` }, signal);
      if (response.statusCode !== 206) {
        // The server sent the whole file: ranges are not on offer here.
        response.destroy();
        rangeUnsupported = true;
        throw new Error("range-unsupported");
      }
      inFlight.set(index, 0);
      try {
        let received = 0;
        for await (const piece of response) {
          const chunk = piece as Buffer;
          await writeAt(fd, chunk, start + received);
          received += chunk.byteLength;
          inFlight.set(index, received);
          report();
        }
        if (received !== chunkSize(index)) throw new Error("The connection ended before the download finished.");
        landedBytes += received;
        done.add(index);
        fs.writeFileSync(ledgerPath, JSON.stringify({ bytes: file.bytes, rangeBytes, done: [...done] } satisfies ChunkLedger));
      } finally {
        inFlight.delete(index);
        response.destroy();
      }
    };

    const worker = async () => {
      for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
        await fetchChunk(index);
      }
    };
    // Settled, not raced: the file descriptor stays open until every worker
    // has let go of it, and one range's hiccup does not discard the ranges the
    // other connections were still landing.
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(rangeConnections, pending.length || 1) }, worker),
    );
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure) {
      if (!rangeUnsupported) throw failure.reason;
      // Sequential fallback: one stream, from the top.
      done.clear();
      fs.rmSync(ledgerPath, { force: true });
      const response = await get(url, {}, signal);
      let received = 0;
      for await (const piece of response) {
        const chunk = piece as Buffer;
        await writeAt(fd, chunk, received);
        received += chunk.byteLength;
        onProgress(received);
      }
      fs.ftruncateSync(fd, received);
    }
  } finally {
    fs.closeSync(fd);
  }

  onVerifying();
  const size = bytesOnDisk(partialPath);
  const digest = await fileDigest(partialPath);
  if (size !== file.bytes || digest !== file.sha256) {
    fs.rmSync(partialPath, { force: true });
    fs.rmSync(ledgerPath, { force: true });
    throw new Error("The downloaded model did not match its published checksum and was removed.");
  }
  fs.rmSync(ledgerPath, { force: true });
  fs.renameSync(partialPath, finalPath);
}

/**
 * Downloads every file one quantization of a model needs, or reports why it
 * could not.
 *
 * The failure message is deliberately about the model, never about the
 * filesystem or the address it came from: those belong in diagnostics.
 */
export async function downloadLocalModel(dataRoot: string, model: CatalogModel, quant: CatalogQuant): Promise<void> {
  if (active) throw new Error("Another model is already downloading.");
  // Nothing to fetch and nothing to verify against: these files are only known
  // because they are already on disk.
  if (model.discovered) throw new Error("That model is already in the models folder.");

  const { id } = model;
  const totalBytes = quant.files.reduce((total, file) => total + file.bytes, 0);
  const abort = new AbortController();
  active = { id, abort };
  let completedBytes = 0;
  // Eight connections report often enough to flood the channel; a progress
  // reading every ~100ms is as smooth as any bar can show.
  let lastProgressAt = 0;
  const publishProgress = (received: number) => {
    const now = Date.now();
    if (now - lastProgressAt < 100) return;
    lastProgressAt = now;
    publish({ id, receivedBytes: received, totalBytes, state: "downloading" });
  };
  publish({ id, receivedBytes: 0, totalBytes, state: "downloading" });

  try {
    for (const file of quant.files) {
      const alreadyThere = bytesOnDisk(modelFilePath(dataRoot, model, file));
      if (alreadyThere === file.bytes) {
        completedBytes += file.bytes;
        publish({ id, receivedBytes: completedBytes, totalBytes, state: "downloading" });
        continue;
      }
      const base = completedBytes;
      await downloadFile(
        dataRoot,
        model,
        file,
        abort.signal,
        (received) => publishProgress(base + received),
        () => publish({ id, receivedBytes: base + file.bytes, totalBytes, state: "verifying" }),
      );
      completedBytes += file.bytes;
    }
    publish({ id, receivedBytes: totalBytes, totalBytes, state: "done" });
  } catch (cause) {
    if (abort.signal.aborted) {
      publish({ id, receivedBytes: completedBytes, totalBytes, state: "cancelled" });
      return;
    }
    publish({ id, receivedBytes: completedBytes, totalBytes, state: "error" });
    throw cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    if (active?.abort === abort) active = null;
  }
}
