/**
 * What this machine can actually run.
 *
 * Memory decides whether a local model is a good experience or a swapping
 * disaster, and it is knowable before anything is downloaded. Which memory
 * counts depends on the machine: a dedicated card runs a model at its own
 * speed only while the model fits in the card, so its memory is the budget and
 * installed RAM is what the overflow falls back to. Where the accelerator
 * shares system memory — Metal, or none at all — installed RAM is the whole
 * answer. Everything here is a pure function of those numbers so it can be
 * tested without a machine to test on.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";

import { recordLocalDiagnostic } from "./diagnostics";
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
 *
 * Every row carries its memory, which is the number that decides whether a
 * model runs on the accelerator or spills back onto the processor, so it is
 * read here rather than thrown away with the rest of the parenthetical.
 */
export type AcceleratorDevice = {
  /** Backend family the row was listed under — "Vulkan", "Metal". */
  backend: string;
  name: string | null;
  /** The memory the row reports, or null when it reports none. */
  memoryGB: number | null;
  /**
   * The device shares system memory rather than adding to it. Metal is always
   * unified: its figure is a working-set window onto installed RAM, so adding
   * it to RAM would count the same gigabytes twice. An integrated GPU is the
   * same arrangement under another name — the memory it reports is a window
   * onto the RAM already counted, not memory of its own.
   */
  unified: boolean;
};

/**
 * "  Vulkan0: NVIDIA GeForce RTX 4070 (discrete, 12282 MiB, 11000 MiB free)"
 *
 * The device kind comes from the patch in third_party: stock llama.cpp prints
 * the parenthetical without it. The group stays optional so a list from an
 * unpatched build still parses, one device short of its classification rather
 * than not at all.
 */
const DEVICE_ROW = /^\s*([A-Za-z][A-Za-z0-9_]*?)\d*:\s*(.+?)\s*$/;
const DEVICE_MEMORY = /\((?:(discrete|integrated|accelerator),\s*)?(\d+)\s*MiB(?:,\s*\d+\s*MiB free)?\)\s*$/;

/**
 * Rows that are not an accelerator on this machine.
 *
 * The processor is always listed. So is BLAS, which on a Mac is Accelerate
 * running on that same processor — a maths library, not a device to offload
 * to, and reporting it as the accelerator says a machine is doing something it
 * is not. RPC is another machine's device entirely. The rest is the heading.
 */
const NOT_AN_ACCELERATOR = /^(cpu|blas|rpc|available|load|device|ggml)/i;

/**
 * Backends whose memory is the machine's own.
 *
 * Apple's is printed as "Metal" by some builds and "MTL" by others, and it is
 * unified under either name: the figure is a working-set window onto installed
 * RAM, so counting it as memory of its own counts the same gigabytes twice.
 * Both spellings are reported as "Metal", which is the family this names
 * everywhere else and the only one of the two a person would recognise.
 */
const UNIFIED_BACKEND = /^(metal|mtl)$/i;

export function parseAcceleratorDevices(output: string): AcceleratorDevice[] {
  const devices: AcceleratorDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(DEVICE_ROW);
    if (!match) continue;
    const [, backend, rest] = match;
    if (NOT_AN_ACCELERATOR.test(backend)) continue;
    const memory = rest.match(DEVICE_MEMORY);
    devices.push({
      backend: UNIFIED_BACKEND.test(backend) ? "Metal" : backend,
      // Only the trailing group, so a name carrying brackets of its own — "AMD
      // Radeon(TM) Graphics" — keeps them instead of being cut at the first.
      name: rest.replace(/\s*\([^()]*\)\s*$/, "").trim() || null,
      memoryGB: memory ? Number(memory[2]) / 1024 : null,
      unified: UNIFIED_BACKEND.test(backend) || memory?.[1] === "integrated",
    });
  }
  return devices;
}

/**
 * The memory a model has to fit into to run at the accelerator's speed.
 *
 * Dedicated cards add up: two of them hold a model neither would hold alone.
 * A unified device contributes nothing here because its memory is already
 * counted as RAM, and a device that reported no figure contributes nothing
 * because it said nothing — null means unknown, and an unknown that is read as
 * zero becomes a machine wrongly told it cannot run anything.
 */
export function acceleratorMemoryGB(devices: AcceleratorDevice[]): number | null {
  const dedicated = devices.filter((device) => !device.unified && device.memoryGB !== null);
  if (dedicated.length === 0) return null;
  return dedicated.reduce((total, device) => total + (device.memoryGB ?? 0), 0);
}

/**
 * What a model is weighed against on this machine.
 *
 * `vramGB` is null whenever the accelerator's memory is the machine's own:
 * no accelerator, a unified one, or one that reported no figure. In every one
 * of those cases installed RAM is the whole answer, which is what this asked
 * before any of it could be known.
 *
 * An integrated GPU under Vulkan reports a window onto system memory as if it
 * were its own, and is excluded here for the same reason Metal is. It is not
 * excluded from what the machine can run: llama.cpp offloads to an integrated
 * GPU only when no discrete one is present, and in that case installed RAM is
 * already the honest budget, which is what a null vramGB says.
 */
export type MemoryBudget = {
  ramGB: number;
  vramGB: number | null;
};

/** The memory a model must fit to run fully accelerated. */
export function fastMemoryGB(budget: MemoryBudget): number {
  return budget.vramGB ?? budget.ramGB;
}

/**
 * The memory a model can reach at all. A dedicated card keeps the layers it
 * holds and passes the rest to the processor, so the machine's own memory
 * backs what the card could not take.
 */
export function backingMemoryGB(budget: MemoryBudget): number {
  return budget.vramGB === null ? budget.ramGB : budget.vramGB + budget.ramGB;
}

/**
 * How well this machine is set up to run a local model, independent of which
 * model is chosen. Memory decides how large a model fits; an accelerator
 * decides whether it answers at a usable speed.
 */
export function systemQuality(budget: MemoryBudget, accelerator: string | null): SystemProfile["quality"] {
  if (!accelerator) return "cpu";
  return fastMemoryGB(budget) >= 16 ? "optimal" : "good";
}

function listDevicesOutput(): Promise<{ output: string; note: string }> {
  return new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(llamaServerBinaryPath(), ["--list-devices"], { windowsHide: true });
    } catch {
      // No packaged runtime yet — running from source before a packaging build.
      // The machine is still worth reporting, just without its accelerator.
      resolve({ output: "", note: "no packaged runtime" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ output, note: "probe timed out after 10s" });
    }, 10_000);
    const collect = (chunk: Buffer | string) => { output += chunk.toString(); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => { clearTimeout(timer); resolve({ output, note: `spawn failed: ${error.message}` }); });
    // "close", not "exit": the device rows leave llama-server through a
    // block-buffered pipe that flushes at process end, and exit can fire
    // before that data has been read — a probe that then reports a GPU
    // machine as CPU-only. close waits for the streams to drain.
    child.once("close", (code) => { clearTimeout(timer); resolve({ output, note: `exit ${code}` }); });
  });
}

// Spawning a probe process per ask would be wasteful, so the answer is cached
// and warmed at launch — but not unconditionally forever: a probe that found
// no accelerator may be the machine, or may be a cold start (a driver still
// initializing, antivirus scanning the freshly installed binary, the 10s
// timeout). A GPU answer is trusted for the app's lifetime; a CPU-only answer
// is re-probed on the next ask, at most every 30 seconds, so one bad launch
// probe does not misreport the machine — and mis-size every model
// recommendation — until the app restarts.
let cachedProfile: SystemProfile | null = null;
let probing: Promise<SystemProfile> | null = null;
let lastProbeAt = 0;
let lastRecordedProbe = "";
const cpuOnlyReprobeMs = 30_000;

export function systemProfile(): Promise<SystemProfile> {
  if (cachedProfile && (cachedProfile.accelerator !== null || Date.now() - lastProbeAt < cpuOnlyReprobeMs)) {
    return Promise.resolve(cachedProfile);
  }
  if (!probing) {
    probing = (async () => {
      const probe = await listDevicesOutput();
      const devices = parseAcceleratorDevices(probe.output);
      // The raw probe, kept where an exported diagnostics file shows it: "No
      // GPU acceleration" on a machine with a GPU is otherwise undiagnosable
      // from a report. Once per distinct outcome, not per probe — the
      // CPU-only path re-probes on a timer.
      const recorded = `${devices.map((device) => device.backend).join(",") || "none"}|${probe.note}`;
      if (recorded !== lastRecordedProbe) {
        lastRecordedProbe = recorded;
        recordLocalDiagnostic({
          level: "warn",
          source: "desktop",
          event: "hardware.device_probe",
          message: devices.length === 0
            ? "The runtime probe found no accelerator device."
            : `The runtime probe found: ${devices.map((device) => `${device.backend} (${device.name})`).join(", ")}`,
          data: { note: probe.note, output: probe.output.trim().slice(-2000) },
        });
      }
      const budget = { ramGB: totalRamGB(), vramGB: acceleratorMemoryGB(devices) };
      const first = devices[0] ?? null;
      const profile: SystemProfile = {
        totalRamGB: Math.round(budget.ramGB),
        vramGB: budget.vramGB === null ? null : Math.round(budget.vramGB),
        accelerator: first?.backend ?? null,
        acceleratorDevice: first?.name ?? null,
        quality: systemQuality(budget, first?.backend ?? null),
      };
      cachedProfile = profile;
      lastProbeAt = Date.now();
      return profile;
    })().finally(() => {
      probing = null;
    });
  }
  return probing;
}

/** This machine's budget, from the same cached answer the profile is built from. */
export async function memoryBudget(): Promise<MemoryBudget> {
  const profile = await systemProfile();
  return { ramGB: profile.totalRamGB, vramGB: profile.vramGB };
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
export function recommendedModelId(kind: CatalogModelKind, budget: MemoryBudget): string {
  const room = fastMemoryGB(budget);
  const candidates = catalogModels(kind).filter((model) => !model.uncensored);
  const fitting = candidates.filter((model) => model.minRamGB <= room);
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

export function memoryFit(model: CatalogModel, quant: CatalogQuant, budget: MemoryBudget): MemoryFit {
  const needed = neededRamGB(model, quant);
  if (fastMemoryGB(budget) >= needed) return "comfortable";
  // The comfortable figure carries headroom for context and the rest of the
  // machine; three quarters of it is about where the weights themselves stop
  // fitting. A dedicated card counts the machine's memory behind it here,
  // because the layers it cannot hold run from there rather than not at all.
  if (backingMemoryGB(budget) >= needed * 0.75) return "tight";
  return "exceeds";
}

export type CatalogModelAvailability = {
  model: CatalogModel;
  recommended: boolean;
};

export function catalogAvailability(kind: CatalogModelKind, budget: MemoryBudget): CatalogModelAvailability[] {
  const recommended = recommendedModelId(kind, budget);
  return catalogModels(kind).map((model) => ({ model, recommended: model.id === recommended }));
}
