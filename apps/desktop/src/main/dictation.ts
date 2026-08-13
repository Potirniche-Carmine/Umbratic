/**
 * Dictation transport.
 *
 * The renderer owns the microphone — it is the only place with an audio stack —
 * and this process owns the connection to Veil, because the renderer must never
 * hold the endpoint's credentials. So audio arrives here in chunks over IPC and
 * leaves over one long-lived POST, and the transcripts Veil streams back are
 * pushed to the renderer as they arrive.
 *
 * There is one session at a time. A session id would describe state the product
 * cannot reach: there is one microphone and one composer, and starting a second
 * dictation means the first is over.
 */

import type { ClientRequest, IncomingMessage } from "node:http";
import type { WebContents } from "electron";

import { configuredEndpointRoute, endpointProvider } from "./endpointConfig";
import { openProviderStream } from "./providerClient";
import { connectedVeilSupports, veilFeature, veilFeatureUnavailableMessage } from "./veilFeatures";
import type { DictationEvent } from "../shared/desktopApi";

/** The channel dictation events reach the renderer on. */
export const dictationEventChannel = "umbratic:dictation-event";

type ActiveDictation = {
  request: ClientRequest;
  webContents: WebContents;
  /** Set once a terminal event has been delivered, so none can follow it. */
  finished: boolean;
};

let active: ActiveDictation | null = null;

function deliver(session: ActiveDictation, event: DictationEvent): void {
  if (session.finished) return;
  if (event.kind !== "partial") session.finished = true;
  if (session.webContents.isDestroyed()) return;
  session.webContents.send(dictationEventChannel, event);
}

/**
 * Reads Veil's `event:`/`data:` frames out of the response stream.
 *
 * Frames are separated by a blank line and can be split across reads, so the
 * tail of the buffer is kept until its terminator arrives rather than parsed
 * early and lost.
 */
function readTranscriptStream(session: ActiveDictation, response: IncomingMessage): void {
  if (response.statusCode !== 200) {
    response.resume();
    deliver(session, {
      kind: "error",
      message: response.statusCode === 404
        ? veilFeatureUnavailableMessage(veilFeature.speechTranscribe)
        : "Dictation failed. Please try again.",
    });
    return;
  }

  let buffer = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    buffer += chunk;
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      handleFrame(session, buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
    }
  });
  response.once("end", () => {
    // A stream that ends without a final event is a dropped connection, not a
    // silent recording. Saying so beats leaving the button spinning.
    deliver(session, { kind: "error", message: "Dictation ended before the transcript arrived." });
    if (active?.request === session.request) active = null;
  });
  response.once("error", () => {
    deliver(session, { kind: "error", message: "Dictation failed. Please try again." });
    if (active?.request === session.request) active = null;
  });
}

function handleFrame(session: ActiveDictation, frame: string): void {
  let name = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) name = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!name || !data) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  const text = typeof payload.text === "string" ? payload.text : "";

  switch (name) {
    case "partial":
      deliver(session, { kind: "partial", text });
      break;
    case "final":
      deliver(session, { kind: "final", text, truncated: payload.truncated === true });
      break;
    case "error":
      deliver(session, { kind: "error", message: "Dictation failed. Please try again." });
      break;
  }
}

export function startDictation(input: { language?: string }, webContents: WebContents): { started: boolean } {
  cancelDictation();

  // Security-semantic gate: an older Veil has no transcribe route, and finding
  // that out by streaming a recording at it is the wrong order.
  if (!connectedVeilSupports(veilFeature.speechTranscribe)) {
    throw new Error(veilFeatureUnavailableMessage(veilFeature.speechTranscribe));
  }

  const provider = endpointProvider();
  const language = (input.language ?? "").trim();
  const route = configuredEndpointRoute(provider.baseUrl, "/api/transcribe")
    + (language ? `?language=${encodeURIComponent(language)}` : "");

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Accept: "text/event-stream",
    ...provider.headers,
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const { request, response } = openProviderStream(route, { headers, mtls: provider.mtls });
  const session: ActiveDictation = { request, webContents, finished: false };
  active = session;

  request.once("error", () => {
    deliver(session, { kind: "error", message: "Dictation could not reach the server." });
    if (active?.request === request) active = null;
  });
  void response.then(
    (incoming) => readTranscriptStream(session, incoming),
    () => deliver(session, { kind: "error", message: "Dictation could not reach the server." }),
  );

  return { started: true };
}

/**
 * Writes one slice of captured audio. Backpressure is deliberately ignored:
 * 16 kHz mono is 32 KB/s, and a socket that cannot keep up with that has
 * already failed in a way the error path will report.
 */
export function sendDictationAudio(input: { chunk: Uint8Array }): void {
  if (!active || active.finished) return;
  if (!input.chunk?.byteLength) return;
  active.request.write(Buffer.from(input.chunk));
}

/** Ends the recording. Veil answers with one last transcript over the same response. */
export function stopDictation(): void {
  if (!active || active.finished) return;
  active.request.end();
}

/** Abandons the recording without waiting for a transcript. */
export function cancelDictation(): void {
  const session = active;
  active = null;
  if (!session) return;
  session.finished = true;
  session.request.destroy();
}
