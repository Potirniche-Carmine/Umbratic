/**
 * The chat model's `llama-server` sidecar.
 *
 * Local mode is a three-process chain: this sidecar holds the weights, Veil
 * sits in front of it holding the prompts and the policy, and the runner talks
 * only to Veil. Nothing but Veil is ever given this sidecar's address.
 */

import * as fs from "node:fs";

import { createLlamaSupervisor, type LlamaConnection, type LlamaDiagnosticSink } from "./llamaServer";

export type LocalLlamaRequest = {
  /** Absolute path to the downloaded GGUF weights. */
  modelFile: string;
  /**
   * The catalog id the server advertises as its model name. Without an alias
   * llama-server reports the weights file path, Veil never finds the model it
   * was configured with, and its health check answers 503 forever.
   */
  modelId: string;
  contextLength: number;
};

const supervisor = createLlamaSupervisor({ label: "llama" });

/**
 * The address and bearer the chat sidecar will use for the rest of this app
 * run. Veil is configured with these before the sidecar necessarily exists,
 * which is what lets the sidecar restart without restarting Veil.
 */
export function localLlamaEndpoint(): Promise<LlamaConnection> {
  return supervisor.endpoint();
}

export function currentLocalLlama(): LlamaConnection | null {
  return supervisor.current();
}

export function stopLocalLlama(): void {
  supervisor.stop();
}

/** A person asking for a fresh attempt should not be told to wait out a backoff. */
export function resetLocalLlamaBackoff(): void {
  supervisor.resetBackoff();
}

export function localLlamaArgs(request: LocalLlamaRequest): string[] {
  return [
    "-m", request.modelFile,
    // Serve under the catalog id, which is the name Veil is configured with.
    "--alias", request.modelId,
    "--ctx-size", String(request.contextLength),
    // The chat template, and with it llama.cpp's structured tool-call parsing.
    // Without it the model's tool calls arrive as prose in the content stream.
    "--jinja",
    // One slot. llama.cpp divides --ctx-size between slots, so asking for two
    // would silently halve the context the user configured; concurrent requests
    // queue instead, which on a single-user desktop is the right trade.
    "--parallel", "1",
    // Nothing should be reachable here but Veil.
    "--no-webui",
  ];
}

export async function ensureLocalLlama(
  request: LocalLlamaRequest,
  onDiagnostic: LlamaDiagnosticSink = () => undefined,
): Promise<LlamaConnection> {
  if (!request.modelFile) throw new Error("Download a model in Settings → Connection");
  if (!fs.existsSync(request.modelFile)) throw new Error("Download a model in Settings → Connection");
  if (!request.modelId.trim()) throw new Error("Download a model in Settings → Connection");
  if (!Number.isInteger(request.contextLength) || request.contextLength <= 0) {
    throw new Error("The local context length is not configured.");
  }
  return supervisor.ensure({
    key: JSON.stringify({ modelFile: request.modelFile, modelId: request.modelId, contextLength: request.contextLength }),
    args: localLlamaArgs(request),
    onDiagnostic,
  });
}
