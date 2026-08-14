/**
 * Dictation transport.
 *
 * The renderer owns the microphone — it is the only place with an audio stack —
 * and this process owns everything the audio is sent to, because the renderer
 * must never hold an endpoint's credentials. So audio arrives here in chunks
 * over IPC, and the transcripts are pushed back as they arrive.
 *
 * Where it goes depends on the mode. A company server transcribes through Veil,
 * over one long-lived POST, because that is the boundary the company's policy
 * lives on. Local mode goes straight to the ASR sidecar this process spawned:
 * Veil will not start without a chat model, and making someone load gigabytes
 * of unrelated chat weights before they can speak a sentence is a coupling with
 * nothing behind it. Both paths end in the same events.
 *
 * There is one session at a time. A session id would describe state the product
 * cannot reach: there is one microphone and one composer, and starting a second
 * dictation means the first is over.
 */

import type { ClientRequest, IncomingMessage } from "node:http";
import type { WebContents } from "electron";

import { app } from "electron";

import { recordLocalDiagnostic } from "./diagnostics";
import { configuredEndpointRoute, endpointProvider } from "./endpointConfig";
import { selectedLocalDictationModel } from "./localModels";
import { ensureLocalSpeech, releaseLocalSpeech } from "./localSpeech";
import { startLocalTranscription, type LocalTranscribeSession } from "./localTranscribe";
import { openProviderStream } from "./providerClient";
import { readDictationSettings, readModelEndpointSettings } from "./storage";
import { connectedVeilSupports, veilFeature, veilFeatureUnavailableMessage } from "./veilFeatures";
import type { DictationEvent } from "../shared/desktopApi";

/** What the user must do before local dictation can work. */
export const chooseDictationModelMessage = "Download a dictation model in Settings → Voice";

/** The channel dictation events reach the renderer on. */
export const dictationEventChannel = "umbratic:dictation-event";

type ActiveDictation = {
  /**
   * How audio leaves this process. Local mode drives the sidecar this app
   * spawned; server mode streams to Veil over one long-lived POST.
   */
  transport:
    | { kind: "local"; session: LocalTranscribeSession }
    | { kind: "server"; request: ClientRequest };
  webContents: WebContents;
  /** Set once a terminal event has been delivered, so none can follow it. */
  finished: boolean;
  /** The most recent partial, kept as the fallback transcript. */
  heard: string;
};

let active: ActiveDictation | null = null;

function deliver(session: ActiveDictation, event: DictationEvent): void {
  if (session.finished) return;
  if (event.kind === "partial") {
    session.heard = event.text;
  } else {
    session.finished = true;
    // However this dictation ended, the local model's idle countdown starts
    // now. It is a no-op in server mode, where there is no sidecar.
    releaseLocalSpeech();
  }
  if (session.webContents.isDestroyed()) return;
  session.webContents.send(dictationEventChannel, event);
}

/**
 * Ends a dictation that lost its stream.
 *
 * Words the user actually said are not the connection's to discard: if any
 * transcript arrived before the failure, the last one is delivered as the final
 * result and lands in the prompt. Only a dictation that produced nothing at all
 * is reported as a failure, because then there is nothing to keep.
 */
function deliverInterrupted(session: ActiveDictation, message: string): void {
  if (session.finished) return;
  if (session.heard.trim()) {
    deliver(session, { kind: "final", text: session.heard, truncated: false });
    return;
  }
  deliver(session, { kind: "error", message });
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
    // A stream that ends without a final event dropped the connection. Whatever
    // was already transcribed still stands, so it is kept rather than thrown
    // away with the connection that carried it.
    deliverInterrupted(session, "Dictation ended before the transcript arrived.");
    if (active === session) active = null;
  });
  response.once("error", () => {
    deliverInterrupted(session, "Dictation failed. Please try again.");
    if (active === session) active = null;
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

export async function startDictation(input: { language?: string }, webContents: WebContents): Promise<{ started: boolean }> {
  cancelDictation();

  const dictationSettings = readDictationSettings();
  const settings = readModelEndpointSettings();
  // The chosen language, which the renderer does not hold — settings live here.
  // An explicit tag beats detection on a two-word utterance, where a wrong
  // guess returns confident text in a language the speaker does not use.
  const language = (input.language ?? dictationSettings.language ?? "").trim();

  if (settings.mode === "local") {
    // The transcription model is not resident: it is loaded on the press and
    // released after a spell of not dictating. Waiting for it here means the
    // load lands inside the button's existing starting state rather than as a
    // failed first recording.
    const dictationModel = selectedLocalDictationModel(app.getPath("userData"), dictationSettings.model);
    if (!dictationModel) throw new Error(chooseDictationModelMessage);
    const runtime = await ensureLocalSpeech(
      dictationModel,
      (diagnostic) => recordLocalDiagnostic({ ...diagnostic, source: "desktop" }),
    );

    // Deliberately not through Veil. Veil refuses to start without a chat
    // model, so routing local dictation through it would make speaking a
    // sentence require loading gigabytes of unrelated chat weights first. This
    // sidecar was spawned by this process, listens on loopback, and holds a key
    // minted for this app run — the boundary Veil exists to hold is not crossed
    // by talking to it.
    const session = {
      webContents,
      finished: false,
      heard: "",
    } as ActiveDictation;
    session.transport = {
      kind: "local",
      session: startLocalTranscription(
        { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, model: dictationModel.modelId },
        language,
        {
          onPartial: (text) => deliver(session, { kind: "partial", text }),
          onFinal: (text, truncated) => {
            deliver(session, { kind: "final", text, truncated });
            if (active === session) active = null;
          },
          onError: (message) => {
            deliverInterrupted(session, message);
            if (active === session) active = null;
          },
        },
      ),
    };
    active = session;
    return { started: true };
  }

  // Security-semantic gate: an older Veil has no transcribe route, and finding
  // that out by streaming a recording at it is the wrong order.
  if (!connectedVeilSupports(veilFeature.speechTranscribe)) {
    throw new Error(veilFeatureUnavailableMessage(veilFeature.speechTranscribe));
  }

  const provider = endpointProvider();
  const route = configuredEndpointRoute(provider.baseUrl, "/api/transcribe")
    + (language ? `?language=${encodeURIComponent(language)}` : "");

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Accept: "text/event-stream",
    ...provider.headers,
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const { request, response } = openProviderStream(route, { headers, mtls: provider.mtls });
  const session: ActiveDictation = { transport: { kind: "server", request }, webContents, finished: false, heard: "" };
  active = session;

  request.once("error", () => {
    deliverInterrupted(session, "Dictation could not reach the server.");
    if (active === session) active = null;
  });
  void response.then(
    (incoming) => readTranscriptStream(session, incoming),
    () => deliverInterrupted(session, "Dictation could not reach the server."),
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
  if (active.transport.kind === "local") active.transport.session.write(input.chunk);
  else active.transport.request.write(Buffer.from(input.chunk));
}

/** Ends the recording. One last transcript follows over whichever transport carried it. */
export function stopDictation(): void {
  if (!active || active.finished) return;
  if (active.transport.kind === "local") active.transport.session.stop();
  else active.transport.request.end();
}

/** Abandons the recording without waiting for a transcript. */
export function cancelDictation(): void {
  const session = active;
  active = null;
  if (!session) return;
  session.finished = true;
  if (session.transport.kind === "local") session.transport.session.cancel();
  else session.transport.request.destroy();
  releaseLocalSpeech();
}
