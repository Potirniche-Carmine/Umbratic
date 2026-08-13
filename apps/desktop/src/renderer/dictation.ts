/**
 * Microphone capture for the composer.
 *
 * The renderer is the only place with an audio stack, so it owns the microphone;
 * the main process owns the connection to Veil, so it owns the credentials.
 * This module is the seam: it turns a live input device into 16 kHz mono 16-bit
 * PCM and hands the slices over IPC, then applies the transcripts that come
 * back.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import pcmTapUrl from "./pcmTap.worklet.js?url";
import type { DesktopApi, DictationEvent } from "../shared/desktopApi";

/**
 * The rate Veil's WAV header declares, so it is the rate capture has to produce.
 * Opening the context here rather than resampling by hand means the browser's
 * own resampler does the work.
 */
const captureSampleRate = 16000;

/**
 * Veil stops accepting audio at two minutes. Stopping a moment earlier on this
 * side means a long dictation ends as a finished recording rather than as a
 * truncated one.
 */
const maxRecordingMs = 115_000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export type DictationStatus = {
  state: DictationState;
  /** The live transcript, replaced whole on each update while recording. */
  preview: string;
  error: string | null;
};

/**
 * Splices a finished transcript into a draft at the caret.
 *
 * The caret is passed in rather than read from the textarea: pressing the
 * microphone moves focus to the button, and an untouched prompt reports a caret
 * of 0 — which would drop spoken text in front of a draft instead of after it.
 * Null means "nowhere in particular", which is the end.
 */
export function insertTranscript(
  draft: string,
  caret: number | null,
  text: string,
): { prompt: string; caret: number } {
  const at = Math.min(caret ?? draft.length, draft.length);
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return {
    prompt: `${before}${lead}${text}${trail}${after}`,
    caret: before.length + lead.length + text.length,
  };
}

function toPCM16(frame: Float32Array): Uint8Array {
  const out = new Uint8Array(frame.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < frame.length; index += 1) {
    // Clamp before scaling: a sample past ±1 would wrap to the opposite
    // extreme, which is heard as a click rather than as clipping.
    const sample = Math.max(-1, Math.min(1, frame[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}

/**
 * Drives one dictation.
 *
 * `onTranscript` is called once, with the final text, so the composer inserts a
 * finished sentence rather than the last partial. Partials are exposed through
 * `status.preview` for display only — showing them in the prompt itself would
 * mean rewriting text the user might already be editing.
 */
export function useDictation(api: DesktopApi, onTranscript: (text: string) => void): {
  status: DictationStatus;
  toggle(): void;
  cancel(): void;
} {
  const [status, setStatus] = useState<DictationStatus>({ state: "idle", preview: "", error: null });

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const releaseDevice = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
  }, []);

  useEffect(() => {
    return api.onDictationEvent((event: DictationEvent) => {
      if (event.kind === "partial") {
        setStatus((current) => (current.state === "idle" ? current : { ...current, preview: event.text }));
        return;
      }
      releaseDevice();
      if (event.kind === "final") {
        const text = event.text.trim();
        if (text) transcriptRef.current(text);
        setStatus({
          state: "idle",
          preview: "",
          error: event.truncated ? "The recording reached the two-minute limit." : null,
        });
        return;
      }
      setStatus({ state: "idle", preview: "", error: event.message });
    });
  }, [api, releaseDevice]);

  // A dictation must not outlive the composer that started it.
  useEffect(() => {
    return () => {
      releaseDevice();
      void api.cancelDictation().catch(() => undefined);
    };
  }, [api, releaseDevice]);

  const stop = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    // The device is released now but the stream stays open: the last transcript
    // is still on its way, and holding the microphone until it lands would keep
    // the recording indicator lit for no reason.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus((current) => (current.state === "idle" ? current : { ...current, state: "transcribing" }));
    void api.stopDictation().catch(() => undefined);
  }, [api]);

  const start = useCallback(async () => {
    setStatus({ state: "starting", preview: "", error: null });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setStatus({
        state: "idle",
        preview: "",
        error: "Umbratic could not open the microphone. Check its permission in system settings.",
      });
      return;
    }

    try {
      await api.startDictation({});
    } catch (cause) {
      stream.getTracks().forEach((track) => track.stop());
      setStatus({ state: "idle", preview: "", error: (cause as Error).message });
      return;
    }

    // Opening the context at the target rate is what makes the browser resample
    // for us; a 48 kHz device needs no arithmetic here.
    const context = new AudioContext({ sampleRate: captureSampleRate });
    try {
      await context.audioWorklet.addModule(pcmTapUrl);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
      void api.cancelDictation().catch(() => undefined);
      setStatus({ state: "idle", preview: "", error: "Audio capture could not start." });
      return;
    }

    const tap = new AudioWorkletNode(context, "pcm-tap");
    tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
      void api.sendDictationAudio({ chunk: toPCM16(message.data) }).catch(() => undefined);
    };
    // The tap has no output worth hearing, so it is not connected to the
    // destination — routing the microphone to the speakers would echo.
    context.createMediaStreamSource(stream).connect(tap);

    streamRef.current = stream;
    contextRef.current = context;
    stopTimerRef.current = setTimeout(stop, maxRecordingMs);
    setStatus({ state: "recording", preview: "", error: null });
  }, [api, stop]);

  const toggle = useCallback(() => {
    setStatus((current) => {
      if (current.state === "idle") void start();
      else if (current.state === "recording") stop();
      return current;
    });
  }, [start, stop]);

  const cancel = useCallback(() => {
    releaseDevice();
    void api.cancelDictation().catch(() => undefined);
    setStatus({ state: "idle", preview: "", error: null });
  }, [api, releaseDevice]);

  return { status, toggle, cancel };
}
