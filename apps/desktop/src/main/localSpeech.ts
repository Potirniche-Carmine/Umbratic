/**
 * The dictation model's `llama-server` sidecar.
 *
 * Started lazily, on the first press of the microphone, and stopped again once
 * dictation has been idle for a while: an ASR model resident all day costs a
 * gigabyte or more of memory for a feature most sessions never use. Its port
 * and bearer are reserved for the whole app run, so Veil's environment stays
 * valid across those stops and starts.
 */

import * as fs from "node:fs";

import { createLlamaSupervisor, type LlamaConnection, type LlamaDiagnosticSink } from "./llamaServer";

export type LocalSpeechRequest = {
  modelFile: string;
  /** The multimodal projector. llama-server will not load the audio encoder without it. */
  projectorFile: string;
  /** Catalog id the server advertises; Veil names this model in its requests. */
  modelId: string;
};

/**
 * How long a loaded dictation model stays resident after the last dictation.
 *
 * The countdown only ever starts when a dictation ends, and `ensureLocalSpeech`
 * clears it on the next press, so a long recording can never be interrupted by
 * it and every use restarts the full window. Five minutes rather than one:
 * dictation comes in bursts — a message, a reply, another thought — and a
 * one-minute window meant nearly every press in a burst paid the model load
 * (and showed the loading notice) again.
 */
export const speechIdleTimeoutMs = 5 * 60 * 1000;

const supervisor = createLlamaSupervisor({ label: "speech" });
let idleTimer: NodeJS.Timeout | null = null;

export function localSpeechEndpoint(): Promise<LlamaConnection> {
  return supervisor.endpoint();
}

export function currentLocalSpeech(): LlamaConnection | null {
  return supervisor.current();
}

export function stopLocalSpeech(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  supervisor.stop();
  // A deliberate stop is not a failure. Killing a start in flight — the user
  // switching the dictation model off mid-load does exactly that — rejects
  // that start, and without this the next mic press was greeted with "failed
  // to start 1 times. Retrying in Ns." about a failure the user chose.
  supervisor.resetBackoff();
}

function speechKey(request: LocalSpeechRequest): string {
  return JSON.stringify({ modelFile: request.modelFile, projectorFile: request.projectorFile, modelId: request.modelId });
}

/**
 * Whether this press finds the model already resident, so nothing slow stands
 * between the button and an open microphone. False whenever the idle timeout
 * has reclaimed the sidecar, or a different model has been chosen since.
 */
export function isLocalSpeechWarm(request: LocalSpeechRequest): boolean {
  return supervisor.currentKey() === speechKey(request);
}

export function localSpeechArgs(request: LocalSpeechRequest): string[] {
  return [
    "-m", request.modelFile,
    "--alias", request.modelId,
    "--mmproj", request.projectorFile,
    // Transcription is one short clip at a time; a long context would reserve
    // memory no dictation will use.
    "--ctx-size", "4096",
    "--parallel", "1",
    "--no-webui",
  ];
}

/**
 * Starts the sidecar if it is not running and waits for it to answer.
 *
 * Called from the dictation IPC handler before the transcript stream opens, so
 * the model's load time lands inside the button's existing "starting" state
 * rather than as a failed first recording.
 */
export async function ensureLocalSpeech(
  request: LocalSpeechRequest,
  onDiagnostic: LlamaDiagnosticSink = () => undefined,
): Promise<LlamaConnection> {
  if (!fs.existsSync(request.modelFile) || !fs.existsSync(request.projectorFile)) {
    throw new Error("Download a dictation model in Settings → Voice");
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  return supervisor.ensure({
    key: speechKey(request),
    args: localSpeechArgs(request),
    onDiagnostic,
  });
}

/** Starts the idle countdown. Called when a dictation ends, however it ended. */
export function releaseLocalSpeech(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    supervisor.stop();
  }, speechIdleTimeoutMs);
  idleTimer.unref?.();
}
