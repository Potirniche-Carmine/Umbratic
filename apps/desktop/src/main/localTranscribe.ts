/**
 * Transcription against the local ASR sidecar, without Veil in the way.
 *
 * Veil is the policy boundary for prompts, tools, and company credentials, and
 * in server mode it is also what transcribes. Locally it cannot be: Veil refuses
 * to start without a chat model, which would make dictating a prompt depend on
 * having gigabytes of unrelated chat weights loaded first. That is the wrong
 * coupling — someone who only wants to speak a sentence should not have to pick
 * and load a language model to do it.
 *
 * So local mode talks to the sidecar this process spawned itself, over loopback,
 * with a key minted for this app run. Nothing leaves the machine and no
 * credential the renderer must not see is involved, which is the whole of what
 * Veil would be protecting here.
 *
 * The protocol mirrors what Veil does, because the runtime behind both is the
 * same: re-transcribe everything captured so far on each pass rather than only
 * the newest slice. A transcript is not append-only — a model that has heard two
 * more syllables must be free to replace "the curse of" with "recursion", and it
 * can only do that if it still has the audio that produced the first guess.
 */

import * as http from "node:http";

/** The rate capture produces and the rate the WAV header declares. */
const sampleRate = 16000;
const channels = 1;
const sampleBits = 16;
const bytesPerSecond = (sampleRate * channels * sampleBits) / 8;

/**
 * The cap on one dictation. Long enough for a paragraph of prompt, short enough
 * that a microphone left open by accident cannot hold the runtime all afternoon.
 */
export const maxRecordingSeconds = 120;
const maxRecordingBytes = maxRecordingSeconds * bytesPerSecond;

/**
 * How often the audio so far is re-transcribed while the speaker is still
 * going. Short enough that text tracks speech, long enough that one pass
 * usually finishes before the next is due.
 */
const partialIntervalMs = 900;

/**
 * The first guess is withheld until there is enough audio to make one worth
 * showing. Below about half a second a model returns confident nonsense, and a
 * wrong first word distracts more than a short wait.
 */
const minPartialBytes = bytesPerSecond / 2;

/**
 * Qwen3-ASR's own preamble, which llama.cpp currently returns along with the
 * words — "language English<asr_text>hello there" (ggml-org/llama.cpp#26749).
 */
const transcriptMarker = "<asr_text>";

/**
 * Keeps only what follows the last marker. The last, not the first: a speaker
 * who says the marker aloud gets it transcribed inside their text, and taking
 * the first occurrence would then discard their own words.
 *
 * No marker means no words. The model always opens with its preamble, so
 * output cut short before the marker — a recording stopped the moment it
 * began, a clipped generation — is preamble only, and returning it typed
 * "language English…" into the prompt box as if it were dictation.
 */
export function transcriptText(raw: string): string {
  const at = raw.lastIndexOf(transcriptMarker);
  return at < 0 ? "" : raw.slice(at + transcriptMarker.length).trim();
}

/**
 * Wraps little-endian 16-bit samples in the smallest valid WAV container.
 * Written by hand because it is 44 fixed bytes and the alternative is a
 * dependency that would ship inside the app.
 */
export function wavPCM16(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM, uncompressed
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * sampleBits) / 8, 28);
  header.writeUInt16LE((channels * sampleBits) / 8, 32);
  header.writeUInt16LE(sampleBits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The multipart body the OpenAI-compatible transcription route expects. */
function transcriptionBody(boundary: string, wav: Buffer, model: string, language: string): Buffer {
  const field = (name: string, value: string) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.wav"\r\n`
      + "Content-Type: audio/wav\r\n\r\n",
    ),
    wav,
    Buffer.from("\r\n"),
    field("model", model),
    // An explicit language beats detection on short clips: a two-word utterance
    // carries little evidence, and a wrong guess returns confident text in a
    // language the speaker does not use.
    ...(language ? [field("language", language)] : []),
    field("response_format", "json"),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

export type LocalTranscribeTarget = {
  /** The sidecar's loopback address, as the supervisor reserved it. */
  baseUrl: string;
  /** The bearer minted for this app run. */
  apiKey: string;
  /** The alias the sidecar serves under, which the request must name. */
  model: string;
};

/** One transcription pass over everything captured so far. */
export function transcribeOnce(
  target: LocalTranscribeTarget,
  pcm: Buffer,
  language: string,
): Promise<string> {
  if (pcm.length === 0) return Promise.resolve("");
  const url = new URL(`${target.baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`);
  const boundary = `----umbratic${Math.random().toString(16).slice(2)}${pcm.length}`;
  const body = transcriptionBody(boundary, wavPCM16(pcm), target.model, language);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          Authorization: `Bearer ${target.apiKey}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            // The runtime's own body can name file paths and arguments, so it
            // is dropped rather than surfaced.
            reject(new Error("The dictation could not be transcribed."));
            return;
          }
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
            resolve(transcriptText(typeof payload.text === "string" ? payload.text : ""));
          } catch {
            reject(new Error("The dictation could not be transcribed."));
          }
        });
      },
    );
    request.once("error", () => reject(new Error("The dictation could not be transcribed.")));
    request.end(body);
  });
}

export type LocalTranscribeEvents = {
  onPartial(text: string): void;
  onFinal(text: string, truncated: boolean): void;
  onError(message: string): void;
};

export type LocalTranscribeSession = {
  write(chunk: Uint8Array): void;
  /** Ends the recording and runs the final pass over everything captured. */
  stop(): void;
  /** Abandons the recording; no further events are delivered. */
  cancel(): void;
};

/**
 * Drives one local dictation.
 *
 * Passes never overlap: a partial that is still running when the next tick is
 * due simply skips that tick. Two concurrent passes against a single-slot
 * sidecar queue behind each other and make the transcript lag further behind
 * the speaker with every beat.
 */
export function startLocalTranscription(
  target: LocalTranscribeTarget,
  language: string,
  events: LocalTranscribeEvents,
): LocalTranscribeSession {
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let transcribedBytes = 0;
  let truncated = false;
  let running = false;
  let finished = false;
  let stopped = false;

  const audio = () => Buffer.concat(captured, capturedBytes - (capturedBytes % 2));

  const finish = (text: string) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    events.onFinal(text, truncated);
  };

  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    events.onError(message);
  };

  async function pass(isFinal: boolean) {
    running = true;
    try {
      const text = await transcribeOnce(target, audio(), language);
      if (finished) return;
      if (isFinal) finish(text);
      else if (text) events.onPartial(text);
    } catch (cause) {
      // A dropped partial costs one beat of feedback, not the dictation: the
      // final pass still holds every sample.
      if (isFinal) fail(cause instanceof Error ? cause.message : "The dictation could not be transcribed.");
    } finally {
      running = false;
      if (stopped && !isFinal) void pass(true);
    }
  }

  const timer = setInterval(() => {
    if (running || finished || stopped) return;
    if (capturedBytes < minPartialBytes || capturedBytes === transcribedBytes) return;
    transcribedBytes = capturedBytes;
    void pass(false);
  }, partialIntervalMs);
  timer.unref?.();

  const stop = () => {
    if (finished || stopped) return;
    stopped = true;
    // A pass already in flight finishes first; its `finally` starts the final
    // one. Otherwise the final pass starts now.
    if (!running) void pass(true);
  };

  return {
    write(chunk) {
      if (finished || stopped || !chunk.byteLength) return;
      let usable = chunk.byteLength;
      if (capturedBytes + usable >= maxRecordingBytes) {
        usable = maxRecordingBytes - capturedBytes;
        truncated = true;
      }
      if (usable > 0) {
        // Copied, not viewed: a view would hold the whole transferred buffer
        // alive for the length of the recording.
        captured.push(Buffer.from(chunk.subarray(0, usable)));
        capturedBytes += usable;
      }
      // The cap ends the recording rather than silently discarding the rest,
      // so the transcript covers exactly what the user is told it covers.
      if (truncated) stop();
    },
    stop,
    cancel() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
    },
  };
}
