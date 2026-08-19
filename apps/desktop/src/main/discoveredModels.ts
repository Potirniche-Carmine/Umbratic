/**
 * Weights that are in the models folder without this app having put them there.
 *
 * The folder is openable from settings, and once it is open the obvious thing
 * to do with it is to drop a GGUF in — one pulled from Hugging Face by hand, or
 * a model this collection does not offer at all. Before this, such a file sat
 * there doing nothing: the list was built from the catalog and the user's
 * pinned additions, and anything else on disk was invisible.
 *
 * So the folder is read as a third source. A loose `.gguf` becomes a model, and
 * so does any directory that is not one of ours; files that differ only by
 * quantization label collapse into one model with several quants, the way a
 * catalog row does. Nothing is downloaded and nothing is verified here — there
 * is no repository behind these files and no digest to check them against.
 * They are listed because they are present, and running them is the user's
 * call, which is also why they are never the suggested model.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { modelsDirectory } from "./appPaths";
import { quantLabelFromFileName } from "./customModels";
import { modelCatalog, type CatalogFile, type CatalogModel, type CatalogQuant } from "./modelCatalog";
import { readStoredCustomModels } from "./settingsStorage";

/** Split GGUFs cannot be loaded, and these two prefixes are never the weights. */
function isLoadableWeightsFile(name: string): boolean {
  return /\.gguf$/i.test(name)
    && !/^(mmproj|mtp)-/i.test(name)
    && !/-\d{5}-of-\d{5}\.gguf$/i.test(name);
}

/** The file name with its quantization label taken out, e.g. "Qwen3-30B". */
function baseName(name: string): string {
  const withoutExtension = name.replace(/\.gguf$/i, "");
  const quant = quantLabelFromFileName(name);
  const trimmed = quant
    ? withoutExtension.slice(0, withoutExtension.length - quant.length)
    : withoutExtension;
  return trimmed.replace(/[-_. ]+$/, "") || withoutExtension;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function prettyName(text: string): string {
  return text.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || text;
}

/** Ids the catalog and the user's pinned additions already own. */
function reservedDirectoryNames(): Set<string> {
  const names = new Set(modelCatalog.map((entry) => entry.id));
  const stored = readStoredCustomModels();
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
        names.add((entry as { id: string }).id);
      }
    }
  }
  return names;
}

/**
 * Orders a model's quants the way the catalog does: a 4-bit build leads when
 * there is one, otherwise the middle of the size range, and the rest follow
 * from small to large.
 */
function orderQuants(quants: CatalogQuant[]): CatalogQuant[] {
  const bySize = [...quants].sort((a, b) => a.files[0].bytes - b.files[0].bytes);
  const leadIndex = bySize.findIndex((entry) => /^(UD-)?I?Q4/.test(entry.quant));
  const lead = bySize[leadIndex >= 0 ? leadIndex : Math.floor((bySize.length - 1) / 2)];
  return [lead, ...bySize.filter((entry) => entry !== lead)];
}

function fileEntry(directory: string, name: string): CatalogFile | null {
  const stat = fs.statSync(path.join(directory, name), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= 0) return null;
  // No digest: nothing published these bytes, so there is nothing to compare
  // them to. `modelDownloaded` matches on size, which is all that can be known.
  return { name, bytes: stat.size, sha256: "" };
}

/** The models one directory's GGUF files add up to. */
function modelsIn(directory: string, idPrefix: string): CatalogModel[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter(isLoadableWeightsFile);
  } catch {
    return [];
  }
  const groups = new Map<string, CatalogQuant[]>();
  for (const name of names.sort()) {
    const file = fileEntry(directory, name);
    if (!file) continue;
    const base = baseName(name);
    const quant = quantLabelFromFileName(name) ?? "GGUF";
    const quants = groups.get(base) ?? [];
    // Two files claiming the same label in one folder: the first one wins,
    // because there is no way to tell which of them was meant.
    if (!quants.some((entry) => entry.quant === quant)) quants.push({ quant, files: [file] });
    groups.set(base, quants);
  }

  return [...groups].map(([base, quants]) => {
    const ordered = orderQuants(quants);
    return {
      id: `${idPrefix}${slug(base)}`,
      kind: "chat" as const,
      displayName: prettyName(base),
      hfRepo: "",
      hfRevision: "",
      quants: ordered,
      // The same estimate a pinned Hugging Face addition gets: weights, room
      // for a context, and room for the machine.
      minRamGB: Math.max(8, Math.ceil((ordered[0].files[0].bytes / 1e9) * 1.4 + 2)),
      // Unknown weights get no thinking directive and no drafting head: both
      // are things the catalog records after reading a model card.
      reasoning: false,
      discovered: true,
      localDirectory: directory,
    };
  });
}

/**
 * Every runnable GGUF in the models folder that no catalog row or pinned
 * addition accounts for.
 *
 * Read fresh on each call rather than cached: the whole point is that a file
 * dropped into the folder while the app is open shows up in the list, and the
 * cost is one directory listing.
 */
export function listDiscoveredModels(dataRoot: string): CatalogModel[] {
  const root = modelsDirectory(dataRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const reserved = reservedDirectoryNames();
  const models: CatalogModel[] = [];
  // Loose files first: a file dropped straight into the folder is the most
  // likely way one gets here.
  models.push(...modelsIn(root, "local-"));
  for (const entry of entries) {
    if (!entry.isDirectory() || reserved.has(entry.name)) continue;
    models.push(...modelsIn(path.join(root, entry.name), `local-${slug(entry.name)}-`));
  }
  // Ids are derived from names, so two folders could still land on one id.
  const seen = new Set<string>();
  return models.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

export function discoveredModel(dataRoot: string, id: string): CatalogModel | null {
  if (!id.startsWith("local-")) return null;
  return listDiscoveredModels(dataRoot).find((entry) => entry.id === id) ?? null;
}
