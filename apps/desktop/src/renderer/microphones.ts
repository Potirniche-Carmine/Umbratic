/**
 * Turning the browser's device list into the choices a person makes.
 *
 * Kept apart from `dictation.ts` because that module pulls in the audio worklet
 * and cannot be loaded outside a browser; this is arithmetic on strings, and it
 * is the part with the edge cases worth testing.
 */

/** One microphone the machine offers, as the composer's device menu shows it. */
export type DictationDevice = {
  deviceId: string;
  label: string;
  /** True for the entry the operating system routes to by default. */
  isDefault: boolean;
};

/**
 * The name of a microphone, without the bookkeeping around it.
 *
 * Chromium reports Windows inputs as "Default - Microphone (HyperX Cloud III)
 * (03f0:089d)": a role prefix the device id already carries, the name, and the
 * USB vendor and product ids. Only the middle part identifies the thing sitting
 * on the desk, and it is the only part anyone picks by. The id is matched
 * strictly as four hex digits, a colon, and four more, so a parenthesis that
 * belongs to the name — "Mic (Studio 2)" — survives.
 */
export function microphoneLabel(raw: string): string {
  return raw
    .replace(/^(Default|Communications)\s+-\s+/i, "")
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "")
    .trim();
}

/**
 * The microphones worth offering, the default first.
 *
 * Windows publishes its two routing roles — "default" and "communications" — as
 * separate entries alongside the device itself, so one microphone can appear
 * three times. Naming them honestly makes that visible as duplicate rows, which
 * is not a choice. The default entry stays, because "whatever the system is
 * using" is a real thing to pick and it is named as such; the communications
 * alias is dropped, because nothing in this app places a call.
 */
export function microphoneChoices(
  devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>,
): DictationDevice[] {
  const named = devices
    .filter((device) => device.kind === "audioinput" && device.deviceId !== "communications")
    .map((device, index) => ({
      deviceId: device.deviceId,
      // Labels are empty until the microphone has been permitted at least once,
      // which is most of a first session. A numbered fallback beats a blank row.
      label: microphoneLabel(device.label) || `Microphone ${index + 1}`,
      isDefault: device.deviceId === "default",
    }));
  return [...named.filter((device) => device.isDefault), ...named.filter((device) => !device.isDefault)];
}

/** Said when the picked microphone could not be opened and the default was. */
export const microphoneUnavailableMessage =
  "That microphone is unavailable, so the system default is recording.";

/** Said when the device is open and every frame of it is silence. */
export function silentMicrophoneMessage(label: string): string {
  return label
    ? `${label} is not sending any sound. Check that it is not muted, and that it is the input you meant.`
    : "The microphone is not sending any sound. Check that it is not muted.";
}

/**
 * What is asked of the capture device.
 *
 * Echo cancellation is off, and that is the whole reason dictation could open a
 * chosen microphone and then record silence from it. Nothing in this app plays
 * audio, so there is no echo to cancel — but asking for it on macOS routes
 * capture through the system's voice-processing unit, which follows the
 * *default* system input rather than the one named here. Lid closed and a
 * headset in use, that default is a built-in microphone that is not there to
 * record: every frame arrives as zeroes and the transcript comes back empty.
 *
 * The chosen device is `exact` rather than `ideal` for the same reason. A
 * preference that cannot be met is answered with some other microphone's audio,
 * and the wrong device recorded silently is worse than a refusal the caller can
 * explain — so the fallback to the default is taken one level up, deliberately,
 * and said out loud when it happens.
 */
export function captureConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      // Quiet USB headsets and far-field laptop microphones differ by more than
      // the transcriber tolerates; letting the browser even them out costs
      // nothing and is not device-routing the way cancellation is.
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}
