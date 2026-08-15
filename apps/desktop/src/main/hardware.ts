/**
 * What this machine can actually run.
 *
 * Installed memory is the one number that decides whether a local model is a
 * good experience or a swapping disaster, and it is knowable before anything is
 * downloaded. Everything here is a pure function of that number so it can be
 * tested without a machine to test on.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";

import { llamaServerBinaryPath } from "./llamaServer";
import { catalogModels, type CatalogModel, type CatalogModelKind } from "./modelCatalog";
import type { SystemProfile } from "../shared/desktopApi";

export function totalRamGB(totalBytes: number = os.totalmem()): number {
  return totalBytes / 2 ** 30;
}

/**
 * What the bundled runtime says this machine can offload to.
 *
 * `--list-devices` enumerates the backends ggml actually managed to load and
 * exits, so this answers before any model is downloaded and without starting a
 * server. It is the honest source: a machine whose Vulkan loader is missing
 * reports no device here for exactly the same reason inference would fall back
 * to the processor.
 */
export function parseAcceleratorDevices(output: string): { accelerator: string | null; device: string | null } {
  for (const line of output.split(/\r?\n/)) {
    // "  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)"
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*?)\d*:\s*(.+?)\s*$/);
    if (!match) continue;
    const [, backend, rest] = match;
    // The CPU is always listed and is not an accelerator; the heading is not a
    // device row at all.
    if (/^(cpu|available|load|device|ggml)/i.test(backend)) continue;
    return { accelerator: backend, device: rest.replace(/\s*\(.*\)\s*$/, "").trim() || null };
  }
  return { accelerator: null, device: null };
}

/**
 * How well this machine is set up to run a local model, independent of which
 * model is chosen. Memory decides how large a model fits; an accelerator
 * decides whether it answers at a usable speed.
 */
export function systemQuality(ram: number, accelerator: string | null): SystemProfile["quality"] {
  if (!accelerator) return "cpu";
  return ram >= 16 ? "optimal" : "good";
}

// Devices do not change while the app is open, and this spawns a process, so
// it is resolved once per run. It is asynchronous and warmed at launch, so by
// the time anyone opens settings the answer is already sitting in the cache
// instead of being paid for on first look.
let profilePromise: Promise<SystemProfile> | null = null;

function listDevicesOutput(): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(llamaServerBinaryPath(), ["--list-devices"], { windowsHide: true });
    } catch {
      // No packaged runtime yet — running from source before a packaging build.
      // The machine is still worth reporting, just without its accelerator.
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(output);
    }, 10_000);
    const collect = (chunk: Buffer | string) => { output += chunk.toString(); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", () => { clearTimeout(timer); resolve(output); });
    child.once("exit", () => { clearTimeout(timer); resolve(output); });
  });
}

export function systemProfile(): Promise<SystemProfile> {
  if (!profilePromise) {
    profilePromise = (async () => {
      const ram = totalRamGB();
      const { accelerator, device } = parseAcceleratorDevices(await listDevicesOutput());
      return {
        totalRamGB: Math.round(ram),
        accelerator,
        acceleratorDevice: device,
        quality: systemQuality(ram, accelerator),
      };
    })();
  }
  return profilePromise;
}

/**
 * The model suggested for this machine.
 *
 * A suggestion only. Nothing is withheld from anyone: a smaller machine can
 * still choose the 27B and watch it run slowly, which is their call to make.
 * Uncensored builds are never suggested — a recommendation is what somebody
 * gets without choosing, and that is a choice worth making deliberately.
 */
export function recommendedModelId(kind: CatalogModelKind, ram: number): string {
  if (kind === "dictation") return ram < 16 ? "qwen3-asr-0.6b" : "qwen3-asr-1.7b";
  if (ram < 12) return "gemma4-e2b";
  if (ram < 16) return "gemma4-e4b";
  // 32 GB, not 64: the 27B's default quantization is about 17 GB of weights,
  // and with the KV cache for a long context on top it wants roughly 22 GB to
  // be comfortable. A 32 GB machine has that, and the 27B is the only model
  // here whose tool calling holds up over a long agentic run — recommending
  // the 12B to a 48 GB laptop was sending the machine's whole advantage
  // unused. Below 32 the 12B is still the one that will feel good, and the
  // 27B stays one click away for anyone who wants it.
  if (ram < 32) return "gemma4-12b";
  return "qwen38-27b";
}

export type CatalogModelAvailability = {
  model: CatalogModel;
  recommended: boolean;
};

export function catalogAvailability(kind: CatalogModelKind, ram: number): CatalogModelAvailability[] {
  const recommended = recommendedModelId(kind, ram);
  return catalogModels(kind).map((model) => ({ model, recommended: model.id === recommended }));
}
