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
import {
  captureConstraints,
  microphoneChoices,
  microphoneLabel,
  microphoneUnavailableMessage,
  silentMicrophoneMessage,
  type DictationDevice,
} from "./microphones";
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
 * How long a dictation failure stays up.
 *
 * It is a note about a press that did not work, not a condition of the
 * composer, so it clears itself: an error that outlives the attempt sits over
 * the prompt for the rest of the session and starts reading as chrome.
 */
const errorNoticeMs = 8000;

/**
 * How long a recording may hear nothing before saying so.
 *
 * A microphone that is open but delivering digital silence is indistinguishable
 * from one that is working while nobody talks — until the transcript comes back
 * empty and the whole press looks like it did nothing. Long enough that a pause
 * before speaking does not trip it, short enough to still be about this press.
 */
const silenceNoticeMs = 5000;

/**
 * The level below which a frame is treated as nothing at all. Room tone through
 * a live microphone sits an order of magnitude above this; a device that is not
 * actually feeding the app reads as exactly zero.
 */
const silenceFloor = 0.004;


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
  /** Takes the failure notice down early. It goes on its own regardless. */
  dismissError(): void;
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
  // Whether anything at all has been heard on this recording, and the timer
  // that complains if nothing has. Disarmed by the first frame with sound in it.
  const heardSoundRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const stopMetering = useCallback(() => {
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
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
      // Only prune against a list that actually names devices. Until the
      // microphone has been permitted once, Chromium answers with a single
      // anonymous row carrying no id at all, and dropping the stored choice
      // against that list forgot the headset the user picked last session.
      if (!inputs.some((device) => device.deviceId)) return;
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
    // Re-read before writing rather than merging onto the copy taken at mount.
    // Saving the whole settings record means every field in the stale copy is
    // written back too, and a dictation model downloaded in Voice settings
    // after this composer mounted was silently reset to "off" by the act of
    // choosing a microphone — which then failed the next press with "Download
    // a dictation model".
    void (async () => {
      const settings = await api.getDictationSettings().catch(() => settingsRef.current);
      if (!settings) return;
      const saved = { ...settings, deviceId: next || null };
      settingsRef.current = saved;
      // Saving a microphone does not disturb the loaded model: the main process
      // restarts the speech runtime only when the model itself changes.
      await api.saveDictationSettings(saved).catch(() => undefined);
    })();
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
    // A chosen microphone that has since been unplugged still falls back to the
    // default — but as a second, deliberate attempt that says so, rather than by
    // asking for a preference the browser can quietly answer with another
    // device's audio.
    let fellBack = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia(captureConstraints(deviceId));
    } catch {
      try {
        if (!deviceId) throw new Error("no device");
        stream = await navigator.mediaDevices.getUserMedia(captureConstraints(""));
        fellBack = true;
      } catch {
        void api.cancelDictation().catch(() => undefined);
        // Consent was already given, so this is a device problem rather than a
        // permission one, and saying which is the difference between a user who
        // plugs in a headset and one who hunts through system settings.
        setStatus({ state: "idle", preview: "", level: 0, error: "No microphone is available." });
        return;
      }
    }
    // What is actually recording, which after a fallback is not what was picked.
    const openLabel = microphoneLabel(stream.getAudioTracks()[0]?.label ?? "");

    // Consent has now been given at least once, which is the moment the browser
    // starts reporting real device ids and names. Until then the list is a row
    // of "Microphone 1" with blank ids, so the device menu was offering choices
    // that could not be told apart or reliably chosen.
    void navigator.mediaDevices.enumerateDevices().then(
      (listed) => setDevices(microphoneChoices(listed)),
      () => undefined,
    );

    // Opening the context at the target rate is what makes the browser resample
    // for us; a 48 kHz device needs no arithmetic here.
    const context = new AudioContext({ sampleRate: captureSampleRate });
    try {
      await context.audioWorklet.addModule(pcmTapUrl);
      // A context built after a slow await — and loading local ASR weights is
      // tens of seconds of them — is far enough from the press that the page may
      // no longer count as user-activated, and an autoplay-suspended context
      // runs no worklet at all. Resuming is a no-op when it was already running.
      if (context.state === "suspended") await context.resume();
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
      void api.cancelDictation().catch(() => undefined);
      setStatus({ state: "idle", preview: "", level: 0, error: "Audio capture could not start." });
      return;
    }

    const tap = new AudioWorkletNode(context, "pcm-tap");
    tap.port.onmessage = (message: MessageEvent<Float32Array>) => {
      const level = frameLevel(message.data);
      if (level > silenceFloor) heardSoundRef.current = true;
      levelRef.current = Math.max(levelRef.current, level);
      void api.sendDictationAudio({ chunk: toPCM16(message.data) }).catch(() => undefined);
    };
    // The tap has no output worth hearing, so it is not connected to the
    // destination — routing the microphone to the speakers would echo.
    context.createMediaStreamSource(stream).connect(tap);

    streamRef.current = stream;
    contextRef.current = context;
    stopTimerRef.current = setTimeout(stop, maxRecordingMs);
    // A device that is open but sending zeroes looks exactly like a working one
    // until the transcript comes back empty. The recording is not stopped — the
    // words might still be arriving — but the notice turns a press that appeared
    // to do nothing into a device problem with somewhere to go.
    heardSoundRef.current = false;
    silenceTimerRef.current = setTimeout(() => {
      if (heardSoundRef.current) return;
      setStatus((current) => (
        current.state === "recording" ? { ...current, error: silentMicrophoneMessage(openLabel) } : current
      ));
    }, silenceNoticeMs);
    // The peak is drained on every frame, so the meter falls back to quiet on
    // its own rather than holding the loudest moment of the whole recording.
    levelTimerRef.current = setInterval(() => {
      const level = levelRef.current;
      levelRef.current = 0;
      setStatus((current) => (current.state === "recording" ? { ...current, level } : current));
    }, levelFrameMs);
    setStatus({ state: "recording", preview: "", level: 0, error: fellBack ? microphoneUnavailableMessage : null });
  }, [api, deviceId, stop, stopMetering]);

  // Read through a ref rather than from inside a `setStatus` updater. An
  // updater is called during render and may be called more than once, so
  // starting a recording from inside one could open the microphone twice for a
  // single press — and the second attempt cancels the first.
  const stateRef = useRef(status.state);
  stateRef.current = status.state;

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") void start();
    else if (stateRef.current === "recording") stop();
  }, [start, stop]);

  const cancel = useCallback(() => {
    releaseDevice();
    void api.cancelDictation().catch(() => undefined);
    setStatus({ state: "idle", preview: "", level: 0, error: null });
  }, [api, releaseDevice]);

  const dismissError = useCallback(() => {
    setStatus((current) => (current.error === null ? current : { ...current, error: null }));
  }, []);

  // The notice takes itself down. Keyed on the message so a second failure
  // restarts the clock rather than inheriting the first one's remaining time.
  useEffect(() => {
    if (!status.error) return;
    const timer = setTimeout(dismissError, errorNoticeMs);
    return () => clearTimeout(timer);
  }, [dismissError, status.error]);

  return { status, toggle, cancel, dismissError, devices, deviceId, selectDevice };
}

export type { DictationDevice } from "./microphones";
