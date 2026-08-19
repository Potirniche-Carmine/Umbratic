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
  /**
   * Multi-token prediction, when the model has a head and the user has it on.
   * `draftFile` is a separate head on disk; null says the head is inside the
   * weights, where llama-server finds it by itself.
   */
  mtp: { draftFile: string | null } | null;
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
    // Speculative decoding from the model's own MTP head: it drafts a couple
    // of tokens and the model verifies them in one pass, which is the same
    // output faster. Two is the draft length that holds up across GPUs; more
    // pays off only on fast cards. A head that is not in the weights is named
    // as the draft model.
    ...(request.mtp
      ? [
          "--spec-type", "draft-mtp",
          "--spec-draft-n-max", "2",
          ...(request.mtp.draftFile ? ["--model-draft", request.mtp.draftFile] : []),
        ]
      : []),
  ];
}

export async function ensureLocalLlama(
  request: LocalLlamaRequest,
  onDiagnostic: LlamaDiagnosticSink = () => undefined,
): Promise<LlamaConnection> {
  if (!request.modelFile) throw new Error("Download a model in Settings → Connection");
  if (!fs.existsSync(request.modelFile)) throw new Error("Download a model in Settings → Connection");
  if (!request.modelId.trim()) throw new Error("Download a model in Settings → Connection");
  if (request.mtp?.draftFile && !fs.existsSync(request.mtp.draftFile)) {
    throw new Error("Download a model in Settings → Connection");
  }
  if (!Number.isInteger(request.contextLength) || request.contextLength <= 0) {
    throw new Error("The local context length is not configured.");
  }
  return supervisor.ensure({
    key: JSON.stringify({
      modelFile: request.modelFile,
      modelId: request.modelId,
      contextLength: request.contextLength,
      mtp: request.mtp,
    }),
    args: localLlamaArgs(request),
    onDiagnostic,
  });
}
