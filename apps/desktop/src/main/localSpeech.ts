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
 * it however far past a minute the speaker goes.
 */
export const speechIdleTimeoutMs = 60 * 1000;

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
    key: JSON.stringify({ modelFile: request.modelFile, projectorFile: request.projectorFile, modelId: request.modelId }),
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
