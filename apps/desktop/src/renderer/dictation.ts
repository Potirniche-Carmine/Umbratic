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
import { microphoneChoices, type DictationDevice } from "./microphones";
import type { DesktopApi, DictationEvent, DictationSettings } from "../shared/desktopApi";

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

/**
 * "starting" covers the whole of getting ready: taking microphone consent and,
 * in local mode, loading the ASR weights — which is the slow part, and the
 * reason the button spins rather than jumping straight to a live indicator.
 */
export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export type DictationStatus = {
  state: DictationState;
  /** The live transcript, replaced whole on each update while recording. */
  preview: string;
  /**
   * How loud the microphone is right now, 0 to 1, for the level meter. Zero
   * whenever nothing is being captured.
   */
  level: number;
  error: string | null;
};

/** How often the level meter is repainted. Fast enough to look live, slow
 *  enough that a 125-frame-per-second capture does not drive React. */
const levelFrameMs = 50;

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
 * How loud one captured frame is, on the 0–1 scale the meter draws.
 *
 * Root mean square rather than peak: peak follows the sharpest click in the
 * room, and a meter that spikes on a keystroke reads as noise rather than as
 * speech. The result is scaled because ordinary talking sits near an RMS of
 * 0.1, and a bar that never leaves the bottom tenth looks broken.
 */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index];
  return Math.min(1, Math.sqrt(sum / frame.length) * 6);
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
  /** Microphones this machine offers, for the composer's device menu. */
  devices: DictationDevice[];
  /** The chosen device id, or "" for whatever the system calls default. */
  deviceId: string;
  selectDevice(deviceId: string): void;
} {
  const [status, setStatus] = useState<DictationStatus>({ state: "idle", preview: "", level: 0, error: null });
  const [devices, setDevices] = useState<DictationDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  // The rest of the stored dictation settings, so saving a microphone does not
  // have to invent a model or a language to save alongside it.
  const settingsRef = useRef<DictationSettings | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The loudness the audio thread last reported, and the timer that samples it
  // for the screen. Kept in refs because capture posts a frame every 8 ms and
  // rendering that many times would cost more than the recording does.
  const levelRef = useRef(0);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const stopMetering = useCallback(() => {
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    levelRef.current = 0;
  }, []);

  const releaseDevice = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    stopMetering();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
  }, [stopMetering]);

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
          level: 0,
          error: event.truncated ? "The recording reached the two-minute limit." : null,
        });
        return;
      }
      setStatus({ state: "idle", preview: "", level: 0, error: event.message });
    });
  }, [api, releaseDevice]);

  // A dictation must not outlive the composer that started it.
  useEffect(() => {
    return () => {
      releaseDevice();
      void api.cancelDictation().catch(() => undefined);
    };
  }, [api, releaseDevice]);

  // The microphone list, and the stored choice within it. Both are re-read when
  // devices change: a headset unplugged mid-session must not leave the menu
  // naming it, and a stored id that no longer matches anything falls back to
  // the system default rather than failing the next press.
  useEffect(() => {
    let current = true;
    const load = async () => {
      const listed = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      if (!current) return;
      const inputs = microphoneChoices(listed);
      setDevices(inputs);
      setDeviceId((chosen) => (chosen && !inputs.some((device) => device.deviceId === chosen) ? "" : chosen));
    };
    void api.getDictationSettings().then((settings) => {
      if (!current) return;
      settingsRef.current = settings;
      setDeviceId(settings.deviceId ?? "");
    }, () => undefined);
    void load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => {
      current = false;
      navigator.mediaDevices.removeEventListener("devicechange", load);
    };
  }, [api]);

  const selectDevice = useCallback((next: string) => {
    setDeviceId(next);
    const settings = settingsRef.current;
    if (!settings) return;
    const saved = { ...settings, deviceId: next || null };
    settingsRef.current = saved;
    // Saving a microphone does not disturb the loaded model: the main process
    // restarts the speech runtime only when the model itself changes.
    void api.saveDictationSettings(saved).catch(() => undefined);
  }, [api]);

  const stop = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    stopMetering();
    // The device is released now but the stream stays open: the last transcript
    // is still on its way, and holding the microphone until it lands would keep
    // the recording indicator lit for no reason.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStatus((current) => (current.state === "idle" ? current : { ...current, state: "transcribing", level: 0 }));
    void api.stopDictation().catch(() => undefined);
  }, [api, stopMetering]);

  const start = useCallback(async () => {
    setStatus({ state: "starting", preview: "", level: 0, error: null });

    // Consent first, and from the main process, so the platform asks the way a
    // native app asks. A refusal is explained there, in a window that can offer
    // to open the setting that fixes it — nothing about it belongs under the
    // prompt box, so this returns to rest silently.
    const access = await api.requestMicrophoneAccess().catch(() => ({ granted: true }));
    if (!access.granted) {
      setStatus({ state: "idle", preview: "", level: 0, error: null });
      return;
    }

    // The model loads before the device opens. In local mode this is tens of
    // seconds of weights, and holding an open microphone through it would light
    // the system's recording indicator over a session that has not begun.
    try {
      await api.startDictation({});
    } catch (cause) {
      setStatus({ state: "idle", preview: "", level: 0, error: (cause as Error).message });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          // Preferred, not required: a chosen microphone that has since been
          // unplugged should fall back to the default rather than refuse.
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        },
      });
    } catch {
      void api.cancelDictation().catch(() => undefined);
      // Consent was already given, so this is a device problem rather than a
      // permission one, and saying which is the difference between a user who
      // plugs in a headset and one who hunts through system settings.
      setStatus({ state: "idle", preview: "", level: 0, error: "No microphone is available." });
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
      setStatus({ state: "idle", preview: "", level: 0, error: "Audio capture could not start." });
      return;
    }

    const tap = new AudioWorkletNode(context, "pcm-tap");
    tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
      levelRef.current = Math.max(levelRef.current, frameLevel(message.data));
      void api.sendDictationAudio({ chunk: toPCM16(message.data) }).catch(() => undefined);
    };
    // The tap has no output worth hearing, so it is not connected to the
    // destination — routing the microphone to the speakers would echo.
    context.createMediaStreamSource(stream).connect(tap);

    streamRef.current = stream;
    contextRef.current = context;
    stopTimerRef.current = setTimeout(stop, maxRecordingMs);
    // The peak is drained on every frame, so the meter falls back to quiet on
    // its own rather than holding the loudest moment of the whole recording.
    levelTimerRef.current = setInterval(() => {
      const level = levelRef.current;
      levelRef.current = 0;
      setStatus((current) => (current.state === "recording" ? { ...current, level } : current));
    }, levelFrameMs);
    setStatus({ state: "recording", preview: "", level: 0, error: null });
  }, [api, deviceId, stop, stopMetering]);

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
    setStatus({ state: "idle", preview: "", level: 0, error: null });
  }, [api, releaseDevice]);

  return { status, toggle, cancel, devices, deviceId, selectDevice };
}

export type { DictationDevice } from "./microphones";
