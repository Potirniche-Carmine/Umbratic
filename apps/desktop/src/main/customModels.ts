/**
 * Chat models the user adds by Hugging Face reference.
 *
 * The curated catalog is hand-reviewed; these are not, so the next best thing
 * is applied automatically: at the moment a repository is added, its current
 * revision is resolved to an immutable commit and the size and SHA-256 of
 * every offered file is recorded from the Hugging Face API. From then on a
 * custom model downloads and verifies exactly like a catalog one — the trust
 * decision is made once, at add time, and pinned.
 *
 * Entries share `CatalogModel`'s shape so everything downstream — downloads,
 * verification, llama-server — treats both lists identically.
 */

import * as https from "node:https";

import { modelCatalog, type CatalogModel, type CatalogQuant } from "./modelCatalog";
import { readStoredCustomModels, writeStoredCustomModels } from "./settingsStorage";

const repoPattern = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,127}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const shaPattern = /^[0-9a-f]{64}$/;

/**
 * Reads "author/model" out of whatever the user pasted: the bare reference, a
 * repository URL, or a deep link to a file or tree inside one.
 */
export function parseHuggingFaceReference(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (repoPattern.test(text)) return text;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!/(^|\.)huggingface\.co$/.test(url.hostname) && !/(^|\.)hf\.co$/.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const repo = `${segments[0]}/${segments[1]}`;
    return repoPattern.test(repo) ? repo : null;
  } catch {
    return null;
  }
}

export function customModelId(repo: string): string {
  return `custom-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function customDisplayName(repo: string): string {
  const tail = repo.split("/")[1] ?? repo;
  return tail.replace(/[-_.]gguf$/i, "").replace(/[-_]+/g, " ").trim();
}

/** The quantization label inside a GGUF file name, e.g. "Q4_K_M" or "IQ4_XS". */
export function quantLabelFromFileName(name: string): string | null {
  const match = name.match(/(?:UD-)?(?:I?Q\d[A-Z0-9_]*|BF16|F16|F32)(?=\.gguf$)/i);
  return match ? match[0].toUpperCase() : null;
}

type TreeEntry = { type: string; path: string; lfs?: { oid: string; size: number } };

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = (url) =>
  new Promise((resolve, reject) => {
    const visit = (target: string, hops: number) => {
      if (hops > 5) {
        reject(new Error("Hugging Face redirected too many times."));
        return;
      }
      const request = https.get(target, { headers: { accept: "application/json" }, timeout: 20_000 }, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const next = new URL(location, target);
          if (next.protocol !== "https:") {
            reject(new Error("Hugging Face redirected to an insecure address."));
            return;
          }
          visit(next.toString(), hops + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(status === 401 || status === 403
            ? "That model is gated or private on Hugging Face."
            : status === 404
              ? "That model was not found on Hugging Face."
              : `Hugging Face answered with status ${status}.`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Hugging Face sent an answer that could not be read."));
          }
        });
        response.once("error", reject);
      });
      request.once("timeout", () => request.destroy(new Error("Hugging Face took too long to answer.")));
      request.once("error", reject);
    };
    visit(url, 0);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeQuants(value: unknown): CatalogQuant[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const quants: CatalogQuant[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.quant !== "string" || !Array.isArray(entry.files)) return null;
    const files = entry.files.map((file) => {
      if (!isRecord(file)) return null;
      const { name, bytes, sha256 } = file;
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\")) return null;
      if (typeof bytes !== "number" || !(bytes > 0)) return null;
      if (typeof sha256 !== "string" || !shaPattern.test(sha256)) return null;
      return { name, bytes, sha256 };
    });
    if (files.some((file) => file === null) || files.length === 0) return null;
    quants.push({ quant: entry.quant, files: files as CatalogQuant["files"] });
  }
  return quants;
}

/** The stored list, dropping anything malformed rather than trusting it. */
export function listCustomModels(): CatalogModel[] {
  const stored = readStoredCustomModels();
  if (!Array.isArray(stored)) return [];
  const models: CatalogModel[] = [];
  for (const entry of stored) {
    if (!isRecord(entry)) continue;
    const { id, displayName, hfRepo, hfRevision, minRamGB } = entry;
    if (typeof id !== "string" || !/^custom-[a-z0-9-]{1,160}$/.test(id)) continue;
    if (typeof hfRepo !== "string" || !repoPattern.test(hfRepo)) continue;
    if (typeof hfRevision !== "string" || !revisionPattern.test(hfRevision)) continue;
    const quants = normalizeQuants(entry.quants);
    if (!quants) continue;
    models.push({
      id,
      kind: "chat",
      displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : customDisplayName(hfRepo),
      hfRepo,
      hfRevision,
      quants,
      minRamGB: typeof minRamGB === "number" && minRamGB > 0 ? minRamGB : 8,
      // Unknown weights get no thinking directive: a directive the model
      // ignores is worse than none, because nothing reports it was dropped.
      reasoning: false,
    });
  }
  return models;
}

export function customModel(id: string): CatalogModel | null {
  return listCustomModels().find((entry) => entry.id === id) ?? null;
}

/**
 * Resolves a reference against Hugging Face, pins the current revision, and
 * records every offered GGUF with its published size and digest.
 */
export async function addCustomModel(reference: string, fetchJson: FetchJson = defaultFetchJson): Promise<CatalogModel> {
  const repo = parseHuggingFaceReference(reference);
  if (!repo) throw new Error("Enter a Hugging Face link or author/model reference.");
  const id = customModelId(repo);
  if (modelCatalog.some((entry) => entry.hfRepo.toLowerCase() === repo.toLowerCase())) {
    throw new Error("That model is already in the collection.");
  }
  if (listCustomModels().some((entry) => entry.id === id)) {
    throw new Error("That model has already been added.");
  }

  const info = await fetchJson(`https://huggingface.co/api/models/${repo}`);
  const revision = isRecord(info) && typeof info.sha === "string" ? info.sha : "";
  if (!revisionPattern.test(revision)) throw new Error("Hugging Face did not name a revision for that model.");

  const tree = await fetchJson(`https://huggingface.co/api/models/${repo}/tree/${revision}`);
  const entries = (Array.isArray(tree) ? tree : []) as TreeEntry[];
  const weights = entries.filter((entry) =>
    entry.type === "file"
    && typeof entry.path === "string"
    && /\.gguf$/i.test(entry.path)
    && !entry.path.includes("/")
    && !/^(mmproj|mtp)-/i.test(entry.path)
    && !/-\d{5}-of-\d{5}\.gguf$/i.test(entry.path)
    && isRecord(entry.lfs)
    && typeof entry.lfs.size === "number"
    && entry.lfs.size > 0
    && typeof entry.lfs.oid === "string"
    && shaPattern.test(entry.lfs.oid));
  if (weights.length === 0) {
    const splitOnly = entries.some((entry) => entry.type === "file" && /-\d{5}-of-\d{5}\.gguf$/i.test(entry.path ?? ""));
    throw new Error(splitOnly
      ? "That repository only publishes split GGUF files, which cannot be loaded yet."
      : "That repository does not publish GGUF files Umbratic can run.");
  }

  const seen = new Set<string>();
  const quants: CatalogQuant[] = [];
  for (const entry of weights.sort((a, b) => (a.lfs?.size ?? 0) - (b.lfs?.size ?? 0))) {
    const quant = quantLabelFromFileName(entry.path) ?? entry.path.replace(/\.gguf$/i, "");
    if (seen.has(quant)) continue;
    seen.add(quant);
    quants.push({
      quant,
      files: [{ name: entry.path, bytes: entry.lfs?.size ?? 0, sha256: entry.lfs?.oid ?? "" }],
    });
  }
  // A 4-bit build leads when the repository has one, matching the catalog's
  // default balance point; otherwise the middle of the size range does.
  const leadIndex = quants.findIndex((entry) => /^(UD-)?I?Q4/.test(entry.quant));
  const lead = quants[leadIndex >= 0 ? leadIndex : Math.floor((quants.length - 1) / 2)];
  const ordered = [lead, ...quants.filter((entry) => entry !== lead)];

  const model: CatalogModel = {
    id,
    kind: "chat",
    displayName: customDisplayName(repo),
    hfRepo: repo,
    hfRevision: revision,
    quants: ordered,
    minRamGB: Math.max(8, Math.ceil((lead.files[0].bytes / 1e9) * 1.4 + 2)),
    reasoning: false,
  };

  const stored = readStoredCustomModels();
  writeStoredCustomModels([...(Array.isArray(stored) ? stored : []), model]);
  return model;
}

/** Forgets the entry. Deleting its weights is the caller's decision. */
export function removeCustomModel(id: string): CatalogModel | null {
  const existing = customModel(id);
  if (!existing) return null;
  const stored = readStoredCustomModels();
  writeStoredCustomModels((Array.isArray(stored) ? stored : []).filter(
    (entry) => !(isRecord(entry) && entry.id === id),
  ));
  return existing;
}
