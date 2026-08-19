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
import {
  catalogModels,
  catalogQuantBytes,
  defaultQuant,
  type CatalogModel,
  type CatalogModelKind,
  type CatalogQuant,
} from "./modelCatalog";
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
 * still choose the largest row and watch it run slowly, which is their call to
 * make. Uncensored builds are never suggested — a recommendation is what
 * somebody gets without choosing, and that is a choice worth making
 * deliberately.
 *
 * Derived from the catalog rather than spelled out as a ladder of ids: the
 * catalog lists each kind from the lightest model to the most capable, and the
 * suggestion is the most capable one whose comfortable memory this machine
 * has. Adding a model to the catalog is then the whole job — there is no second
 * table here to keep in step with it.
 */
export function recommendedModelId(kind: CatalogModelKind, ram: number): string {
  const candidates = catalogModels(kind).filter((model) => !model.uncensored);
  const fitting = candidates.filter((model) => model.minRamGB <= ram);
  return (fitting[fitting.length - 1] ?? candidates[0]).id;
}

/**
 * How one quantization of a model sits in this machine's memory.
 *
 * - `comfortable`: the weights and a long context both fit, with room for the
 *   rest of the machine.
 * - `tight`: the weights fit and it will run, but memory will be short and the
 *   machine will feel it.
 * - `exceeds`: the weights alone are more than the machine has; it will swap,
 *   stall, or refuse to load.
 *
 * Said on every row rather than used to hide any of them: what runs slowly on
 * someone's hardware is their call, but it should be a call they made knowing.
 */
export type MemoryFit = "comfortable" | "tight" | "exceeds";

/**
 * The memory a quantization wants to be comfortable in. `minRamGB` is recorded
 * for the model's default quantization; the others scale with their size, so
 * a Q8_0 that is twice the bytes asks for twice the room.
 */
export function neededRamGB(model: CatalogModel, quant: CatalogQuant): number {
  const scale = catalogQuantBytes(quant) / catalogQuantBytes(defaultQuant(model));
  return Math.ceil(model.minRamGB * scale);
}

export function memoryFit(model: CatalogModel, quant: CatalogQuant, ram: number): MemoryFit {
  const needed = neededRamGB(model, quant);
  if (ram >= needed) return "comfortable";
  // The comfortable figure carries headroom for context and the rest of the
  // machine; three quarters of it is about where the weights themselves stop
  // fitting.
  if (ram >= needed * 0.75) return "tight";
  return "exceeds";
}

export type CatalogModelAvailability = {
  model: CatalogModel;
  recommended: boolean;
};

export function catalogAvailability(kind: CatalogModelKind, ram: number): CatalogModelAvailability[] {
  const recommended = recommendedModelId(kind, ram);
  return catalogModels(kind).map((model) => ({ model, recommended: model.id === recommended }));
}
