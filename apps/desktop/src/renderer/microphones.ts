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
