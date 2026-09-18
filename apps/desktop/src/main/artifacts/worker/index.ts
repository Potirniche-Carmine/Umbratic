/**
 * The utility-process wrapper around the engine.
 *
 * It does one thing: receive a job on the parent port, run it, post the result
 * back. No sockets are opened and no network module is imported — the worker's
 * only channels are the message port and the files the parent already resolved
 * for it, which is what lets it be forked with filesystem permissions scoped to
 * the workspace.
 *
 * Every failure becomes a result. A worker that throws its way to an exit tells
 * the parent nothing except that it died, and the parent would have to guess
 * whether anything was written.
 */

import { runArtifactJob, type ArtifactRequest, type ArtifactResponse } from "./engine.js";

type ParentPort = {
  once(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function isRequest(value: unknown): value is ArtifactRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.action === "inspect" || candidate.action === "create" || candidate.action === "edit")
    && typeof candidate.format === "string"
    && typeof candidate.workspaceRoot === "string"
  );
}

async function handle(message: unknown): Promise<ArtifactResponse> {
  if (!isRequest(message)) {
    return {
      ok: false,
      kind: "validation",
      errors: [{ path: "", message: "the worker received a message that is not an artifact job" }],
    };
  }
  try {
    return await runArtifactJob(message);
  } catch (error) {
    return {
      ok: false,
      kind: "runtime",
      errors: [{ path: "", message: String(error instanceof Error ? error.message : error) }],
    };
  }
}

if (parentPort) {
  parentPort.once("message", (event) => {
    void handle(event.data).then((result) => {
      parentPort.postMessage(result);
    });
  });
}
