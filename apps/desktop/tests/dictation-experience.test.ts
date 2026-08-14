import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

const mainSource = read("../src/main/main.ts");
const microphoneSource = read("../src/main/microphone.ts");
const backendSource = read("../src/main/backendSettings.ts");
const rendererDictation = read("../src/renderer/dictation.ts");
const composerControls = read("../src/renderer/ComposerControls.tsx");
const voiceSettings = read("../src/renderer/VoiceSettings.tsx");
const localModelList = read("../src/renderer/LocalModelList.tsx");
const localModelStyles = read("../src/renderer/styles/local-models.css");
const dictationStyles = read("../src/renderer/styles/dictation.css");

test("the window may request the microphone, and nothing else", () => {
  const start = mainSource.indexOf("setPermissionRequestHandler");
  const gate = mainSource.slice(start, mainSource.indexOf("webRequest.onBeforeRequest", start));
  // Audio only: a handler that answered true for "media" would also hand over
  // the camera, which nothing in the app has any use for.
  assert.match(gate, /permission === "media"/);
  assert.match(gate, /every\(\(type\) => type === "audio"\)/);
  assert.match(gate, /setPermissionCheckHandler/);
  assert.doesNotMatch(gate, /callback\(true\)/);
});

test("microphone consent is taken the way the platform takes it", () => {
  // macOS shows nothing at all unless the app asks through this call; Windows
  // has no prompt to show, so the refusal path offers the settings page that
  // actually decides.
  assert.match(microphoneSource, /askForMediaAccess\("microphone"\)/);
  assert.match(microphoneSource, /getMediaAccessStatus\("microphone"\)/);
  assert.match(microphoneSource, /ms-settings:privacy-microphone/);
  assert.match(microphoneSource, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Microphone/);
  assert.match(microphoneSource, /dialog\.showMessageBox/);
});

test("the composer never explains a microphone refusal itself", () => {
  const start = rendererDictation.indexOf("const start = useCallback");
  const startImplementation = rendererDictation.slice(start, rendererDictation.indexOf("const toggle =", start));
  // Consent is asked for before a device is opened, and a refusal returns to
  // rest with no caption — the main process owns that conversation.
  assert.ok(
    startImplementation.indexOf("requestMicrophoneAccess")
    < startImplementation.indexOf("getUserMedia"),
  );
  assert.match(startImplementation, /if \(!access\.granted\)[\s\S]{0,120}error: null/);
  assert.doesNotMatch(rendererDictation, /Check its permission in system settings/);
});

test("the model loads before the microphone opens, so nothing records during the wait", () => {
  const start = rendererDictation.indexOf("const start = useCallback");
  const startImplementation = rendererDictation.slice(start, rendererDictation.indexOf("const toggle =", start));
  assert.ok(startImplementation.indexOf("api.startDictation") < startImplementation.indexOf("getUserMedia"));
});

test("a live recording shows its level, and the level rests at zero otherwise", () => {
  assert.match(rendererDictation, /export function frameLevel/);
  // Sampled on a timer rather than pushed per frame: capture posts every 8 ms.
  assert.match(rendererDictation, /levelTimerRef\.current = setInterval/);
  assert.match(rendererDictation, /state === "recording" \? \{ \.\.\.current, level \} : current/);
  for (const idle of ["const stop", "const cancel"]) {
    assert.ok(rendererDictation.includes(idle));
  }
  assert.match(composerControls, /function DictationLevelMeter/);
  assert.match(composerControls, /<DictationLevelMeter level=\{status\.level\}/);
  assert.match(dictationStyles, /\.dictationBar \{/);
});

test("the level is root mean square, scaled for speech and clamped at the top", () => {
  // Not peak: peak follows the sharpest click in the room, and a meter that
  // spikes on a keystroke reads as noise rather than as a voice.
  const body = rendererDictation.slice(
    rendererDictation.indexOf("export function frameLevel"),
    rendererDictation.indexOf("\n}", rendererDictation.indexOf("export function frameLevel")),
  );
  assert.match(body, /if \(frame\.length === 0\) return 0/);
  assert.match(body, /Math\.min\(1, Math\.sqrt\(sum \/ frame\.length\) \* 6\)/);
});

test("the chat model can be given back without quitting the app", () => {
  const chat = backendSource.slice(
    backendSource.indexOf("export async function unloadLocalModel"),
    backendSource.indexOf("export async function getBackendStatus"),
  );
  assert.match(chat, /stopLocalVeil\(\)/);
  assert.match(chat, /stopLocalLlama\(\)/);
  // Unloading must not turn around and start the stack again.
  assert.match(chat, /getBackendStatus\("never"\)/);
});

test("the dictation list only chooses a model — loading is not a decision there", () => {
  // The model loads when the microphone is pressed and lets itself go a minute
  // after the last dictation, so a control on this list has nothing to do.
  for (const source of [voiceSettings, localModelList]) {
    assert.doesNotMatch(source, /unloadDictationModel/);
  }
  const list = localModelList.slice(localModelList.indexOf("export function DictationModelList"));
  assert.doesNotMatch(list, /Unload|localModelState/);
  // And the plumbing is gone rather than left dangling behind an unused prop.
  for (const source of [backendSource, read("../src/preload/preload.ts"), read("../src/shared/desktopApi.ts")]) {
    assert.doesNotMatch(source, /unloadDictationModel|localSpeechLoaded/);
  }
});

test("pressing the microphone while dictation is off says so, and offers the way in", () => {
  // The one moment someone is definitely interested in dictation. Naming Voice
  // settings means a first-time user who declines still knows where to go.
  const renderer = read("../src/renderer/main.tsx");
  assert.match(renderer, /Dictation is off/);
  assert.match(renderer, /Voice settings/);
  // A small thing floating over the prompt text, not a caption in the rail, a
  // row above the box, or a dialog over the screen: it costs no height, so
  // neither the composer nor the conversation moves to make room for it.
  assert.match(renderer, /className="dictationSetupOverlay"/);
  // The way in is a real button, not a word that happens to be clickable.
  assert.match(renderer, /className="primaryAction dictationSetupAction"/);
  const offerRule = dictationStyles.match(/\.dictationSetupOverlay \{[^}]+\}/s)?.[0] ?? "";
  assert.match(offerRule, /position:\s*absolute/);
  assert.match(offerRule, /z-index:\s*\d+/);
  // Blurs the prompt text back, and stops at the rail so the microphone that
  // raised it stays live underneath.
  assert.match(offerRule, /backdrop-filter:\s*blur\(/);
  assert.match(offerRule, /bottom:\s*44px/);
  assert.doesNotMatch(composerControls, /dictationCaption/);
  assert.doesNotMatch(composerControls, /modalScrim/);
  // The control asks; the composer answers. Keeping the offer out of the rail
  // is what stops it resizing the row it lives in.
  assert.match(composerControls, /onRequestSetup\(\)/);
  assert.match(renderer, /onRequestSetup=\{\(\) => setDictationSetupOffer\(true\)\}/);
  assert.match(renderer, /setSettingsTab\("voice"\)/);
});

test("the live transcript is muted text in the prompt box, never in the rail", () => {
  const renderer = read("../src/renderer/main.tsx");
  // Drawn in the highlight layer under the textarea, so the value — and the
  // caret in it — is left alone until the final text arrives.
  assert.match(renderer, /className="promptDictationGhost"/);
  assert.match(renderer, /dictation\.status\.preview \? \(/);
  // And the placeholder stands down rather than printing under it.
  assert.match(renderer, /dictation\.status\.preview\s+\?\s+""/);
  // A failure is a notice above the box, not a caption that resizes the rail.
  assert.match(renderer, /className="connectionNotice dictationNotice"/);
});

test("local dictation needs its own model and nothing else", () => {
  const dictationMain = read("../src/main/dictation.ts");
  const local = dictationMain.slice(
    dictationMain.indexOf('if (settings.mode === "local") {'),
    dictationMain.indexOf("// Security-semantic gate"),
  );
  // Veil will not start without a chat model, so routing local dictation
  // through it made speaking a sentence require loading gigabytes of unrelated
  // chat weights — and answered "Download a model in Settings → Connection"
  // when none were picked.
  assert.match(local, /const runtime = await ensureLocalSpeech\(/);
  assert.match(local, /startLocalTranscription\(/);
  assert.doesNotMatch(dictationMain, /ensureLocalChatRuntime/);
  assert.doesNotMatch(dictationMain, /currentLocalVeilConnection/);
  // The Veil feature gate still guards the server path, and only that path.
  assert.ok(
    dictationMain.indexOf("connectedVeilSupports(veilFeature.speechTranscribe)")
    > dictationMain.indexOf('if (settings.mode === "local") {'),
  );

  // And the button is live whenever the weights are on disk — waiting for a
  // loaded runtime would hide the control that does the loading.
  const renderer = read("../src/renderer/main.tsx");
  assert.match(renderer, /backend\?\.localDictationReady === true/);
});

test("the local transcription protocol matches the one Veil speaks", () => {
  const transcribe = read("../src/main/localTranscribe.ts");
  // Every pass re-transcribes the whole recording: a model that has heard two
  // more syllables must be free to revise words it already emitted.
  assert.match(transcribe, /\/v1\/audio\/transcriptions/);
  assert.match(transcribe, /Authorization: `Bearer \$\{target\.apiKey\}`/);
  assert.match(transcribe, /field\("response_format", "json"\)/);
  assert.match(transcribe, /language \? \[field\("language", language\)\] : \[\]/);
  // llama.cpp still returns Qwen3-ASR's preamble alongside the words.
  assert.match(transcribe, /raw\.lastIndexOf\(transcriptMarker\)/);
  // Passes never overlap: two at once against a single-slot sidecar queue and
  // the transcript falls further behind the speaker every beat.
  assert.match(transcribe, /if \(running \|\| finished \|\| stopped\) return/);
  assert.match(transcribe, /if \(stopped && !isFinal\) void pass\(true\)/);
});

test("the row that is already picked is not re-saved", () => {
  // Saving an unchanged dictation setting restarts the speech runtime, so
  // clicking the selected row — to read it, or on the way to its Unload button
  // — would silently unload the model.
  assert.match(
    voiceSettings,
    /if \(next\.model === dictation\.model && next\.language === dictation\.language\) return;/,
  );
});

test("list rows and settings buttons answer a press", () => {
  for (const selector of [
    /\.localModelList \.localModelRow\.isSelectable:active \{/,
    /\.localModelList \.localModelRow\.isSelectable:hover \{/,
  ]) {
    assert.match(localModelStyles, selector);
  }
  const buttonStyles = read("../src/renderer/styles/skills-settings.css");
  assert.match(buttonStyles, /\.settingsInlineButton:active:not\(:disabled\),\s*\n\.settingsIconButton:active:not\(:disabled\) \{/);
  // Motion is opt-out, like everywhere else in the app.
  assert.match(localModelStyles, /prefers-reduced-motion[\s\S]{0,400}transform: none/);
});

test("a dropped stream keeps the words that already arrived", () => {
  const dictationMain = read("../src/main/dictation.ts");
  // Speech the user gave is not the connection's to discard: every failure path
  // after a partial hands that partial over as the final transcript, and only a
  // dictation that produced nothing at all reports an error.
  assert.match(dictationMain, /function deliverInterrupted/);
  assert.match(dictationMain, /if \(session\.heard\.trim\(\)\)[\s\S]{0,140}kind: "final"/);
  for (const failure of [
    'deliverInterrupted(session, "Dictation ended before the transcript arrived.")',
    'deliverInterrupted(session, "Dictation failed. Please try again.")',
    'deliverInterrupted(session, "Dictation could not reach the server.")',
  ]) {
    assert.ok(dictationMain.includes(failure), `${failure} must not drop the transcript`);
  }
});

test("the chosen dictation language reaches the transcription request", () => {
  const dictationMain = read("../src/main/dictation.ts");
  // The renderer does not hold the setting, so an empty input must fall through
  // to what Voice actually stored rather than to automatic detection.
  assert.match(dictationMain, /const language = \(input\.language \?\? dictationSettings\.language \?\? ""\)\.trim\(\)/);
  assert.match(dictationMain, /language \? `\?language=\$\{encodeURIComponent\(language\)\}` : ""/);
});

test("unloading never resizes the field the cursor is on", () => {
  // The control lives on the selected model's row inside the menu, the way the
  // dictation list does it — a button that appears beside the trigger moves the
  // trigger out from under the pointer the moment the model finishes loading.
  const selectedRow = localModelList.slice(localModelList.indexOf("isDownloaded isSelectable"));
  assert.match(selectedRow, /selected && onUnload && loaded && !loading/);
  assert.doesNotMatch(localModelList, /modelPickerRow/);
  assert.doesNotMatch(localModelStyles, /\.modelPickerRow/);
});

test("a launch starts with no model picked, so nothing is queued to load", () => {
  const settingsStorage = read("../src/main/settingsStorage.ts");
  const clear = settingsStorage.slice(
    settingsStorage.indexOf("export function clearLocalModelSelection"),
    settingsStorage.indexOf("export function readModelEndpointSettings"),
  );
  // Only the pick is per-session. Mode and URL are configuration and stay.
  assert.match(clear, /local: \{ \.\.\.local, modelId: "" \}/);
  assert.doesNotMatch(clear, /mode:|baseUrl:/);

  // And it runs before anything can read the old pick back out.
  const ready = mainSource.slice(mainSource.indexOf("app.whenReady()"));
  assert.ok(ready.indexOf("clearLocalModelSelection()") < ready.indexOf("registerMainIpc()"));
  assert.ok(ready.indexOf("clearLocalModelSelection()") < ready.indexOf("await createWindow()"));
});

test("the microphone can be chosen from the button it belongs to, and the choice sticks", () => {
  // Always rendered: a control that appears a beat after the composer settles
  // reads as the layout still moving.
  assert.doesNotMatch(composerControls, /devices\.length > 1/);
  assert.match(composerControls, /devices\.length === 0 \? \(/);
  // A device that has gone away must not stay selected, and a stored id that
  // matches nothing falls back to the system default rather than failing.
  assert.match(rendererDictation, /!inputs\.some\(\(device\) => device\.deviceId === chosen\) \? "" : chosen/);
  assert.match(rendererDictation, /addEventListener\("devicechange", load\)/);
  assert.match(rendererDictation, /deviceId \? \{ deviceId: \{ ideal: deviceId \} \} : \{\}/);
  // Persisted, and persisting it must not disturb loaded weights.
  assert.match(rendererDictation, /api\.saveDictationSettings\(saved\)/);
  assert.match(backendSource, /if \(dictation\.model === previousModel\) return/);
  assert.match(read("../src/main/settingsStorage.ts"), /value\.deviceId\.length <= 256/);
});

test("the microphone and its device chevron are one control", () => {
  const styles = read("../src/renderer/styles/dictation.css");
  // Two separate pills read as two unrelated buttons that happen to be
  // adjacent, which is the wrong thing to say about a menu belonging to the
  // button beside it. The outline is on the pair; a short seam divides the
  // halves instead of a full-height rule, so the pair still reads as one object.
  // Anchored to line starts: ".dictationControl.isRecording .dictationButton {"
  // also contains ".dictationButton {" and would match first.
  const rule = (selector: string) => {
    const at = styles.indexOf(`\n${selector} {`);
    return styles.slice(at, styles.indexOf("\n}", at));
  };
  const capsule = rule(".dictationControl");
  assert.match(capsule, /border: 1px solid var\(--line\)/);
  assert.match(capsule, /border-radius: 999px/);
  const mic = rule(".dictationButton");
  assert.match(mic, /border: 0/);
  assert.match(mic, /border-radius: 999px 0 0 999px/);
  const chevron = rule(".dictationDeviceTrigger");
  assert.match(chevron, /border: 0/);
  assert.doesNotMatch(chevron, /border-left:/);
  assert.match(chevron, /border-radius: 0 999px 999px 0/);
  const seam = rule(".dictationDeviceTrigger::before");
  assert.match(seam, /width: 1px/);
  assert.match(seam, /top: 10px/);
  assert.match(seam, /bottom: 10px/);
  // Recording lights the whole capsule, since the whole capsule is the control.
  assert.match(styles, /\.dictationControl\.isRecording \{[\s\S]{0,160}border-color: var\(--red\)/);
  assert.match(styles, /\.dictationControl\.isRecording \.dictationDeviceTrigger \{/);
  assert.match(styles, /\.dictationControl\.isRecording \.dictationDeviceTrigger::before \{/);
});

test("the device menu escapes the shell that would clip it", () => {
  // The prompt shell sets `overflow: hidden`, so a menu left inside it is cut
  // off at the shell's edge rather than shown over the conversation.
  assert.match(composerControls, /createPortal\(/);
  assert.match(composerControls, /style=\{\{ position: "fixed", bottom: menuAt\.bottom, right: menuAt\.right \}\}/);
  const styles = read("../src/renderer/styles/dictation.css");
  const menu = styles.slice(styles.indexOf(".dictationDeviceMenu {"), styles.indexOf("\n}", styles.indexOf(".dictationDeviceMenu {")));
  const composerLayer = Number(/\.composer \{[\s\S]*?z-index: (\d+)/.exec(read("../src/renderer/styles/composer.css"))?.[1]);
  const menuLayer = Number(/z-index: (\d+)/.exec(menu)?.[1]);
  assert.ok(menuLayer > composerLayer, `menu (${menuLayer}) must paint above the composer (${composerLayer})`);
  // A fixed menu must not be left floating away from its trigger.
  assert.match(composerControls, /addEventListener\("scroll", close, true\)/);
  assert.match(composerControls, /addEventListener\("resize", close\)/);
});

test("a microphone is listed by its name, with the hardware ids stripped", async () => {
  const { microphoneLabel } = await import("../src/renderer/microphones.ts");
  // Chromium's Windows shape: a role prefix the device id already carries, the
  // name, then the USB vendor and product ids.
  assert.equal(microphoneLabel("Default - Microphone (HyperX Cloud III) (03f0:089d)"), "Microphone (HyperX Cloud III)");
  assert.equal(microphoneLabel("Communications - Microphone (HyperX Cloud III) (03f0:089d)"), "Microphone (HyperX Cloud III)");
  assert.equal(microphoneLabel("Microphone (HyperX Cloud III) (03f0:089d)"), "Microphone (HyperX Cloud III)");
  assert.equal(microphoneLabel("MacBook Pro Microphone"), "MacBook Pro Microphone");
  // A parenthesis that belongs to the name survives: only a real id is stripped.
  assert.equal(microphoneLabel("Mic (Studio 2)"), "Mic (Studio 2)");
  assert.equal(microphoneLabel("Yeti (Blue) (1234:abcd)"), "Yeti (Blue)");
  assert.equal(microphoneLabel(""), "");
});

test("the default microphone leads the list, and Windows' duplicate is dropped", async () => {
  const { microphoneChoices } = await import("../src/renderer/microphones.ts");
  const chosen = microphoneChoices([
    { kind: "audioinput", deviceId: "default", label: "Default - Microphone (HyperX Cloud III) (03f0:089d)" },
    { kind: "audioinput", deviceId: "communications", label: "Communications - Microphone (HyperX Cloud III) (03f0:089d)" },
    { kind: "audioinput", deviceId: "hash-a", label: "Microphone (HyperX Cloud III) (03f0:089d)" },
    { kind: "audioinput", deviceId: "hash-b", label: "" },
    { kind: "videoinput", deviceId: "cam", label: "Webcam" },
  ]);
  // The communications alias is the same microphone under a second Windows
  // routing role; after honest naming it is a duplicate row, not a choice.
  assert.deepEqual(chosen, [
    { deviceId: "default", label: "Microphone (HyperX Cloud III)", isDefault: true },
    { deviceId: "hash-a", label: "Microphone (HyperX Cloud III)", isDefault: false },
    // Unlabelled until the microphone has been permitted once; numbered rather
    // than blank. The index is the position in the filtered list.
    { deviceId: "hash-b", label: "Microphone 3", isDefault: false },
  ]);
  assert.deepEqual(microphoneChoices([]), []);

  // Named in place rather than duplicated as a synthetic row ahead of the list.
  assert.doesNotMatch(composerControls, /label: "System default"/);
  assert.match(composerControls, /device\.isDefault \? <em>Default:<\/em> : null/);
});

test("the panel says what went wrong in one reserved place", () => {
  // The download notice read from a status a round trip behind the choice, so
  // it announced a problem that had already stopped being true.
  assert.doesNotMatch(voiceSettings, /Finish downloading/);
  assert.match(voiceSettings, /className="connectionFeedback" aria-live="polite"/);
  // Its height is reserved, so a message arriving moves nothing.
  assert.match(read("../src/renderer/styles/settings.css"), /\.connectionFeedback \{\s*\n\s*min-height: 18px;/);
});

test("the prompt box is exactly as wide as the controls above it", () => {
  const dockStyles = read("../src/renderer/styles/composer-controls.css");
  const composerStyles = read("../src/renderer/styles/composer.css");
  // One grid column shared by the dock's children, sized by the control row.
  assert.match(dockStyles, /grid-template-columns: minmax\(min\(100%, var\(--prompt-min-width\)\), max-content\)/);
  // Everything else contributes nothing and then fills the track — without it a
  // long prompt pushes the box out past the row it is meant to match.
  const composer = composerStyles.slice(composerStyles.indexOf(".composer {"), composerStyles.indexOf("\n}"));
  assert.match(composer, /width: 0;\s*\n\s*min-width: 100%;/);
  for (const notice of [".closedChatNotice", ".connectionNotice"]) {
    const rule = dockStyles.slice(dockStyles.indexOf(`${notice} {`));
    assert.match(rule.slice(0, rule.indexOf("\n}")), /width: 0;\s*\n\s*min-width: 100%;/);
  }
  // `fit-content()` is not valid inside `minmax()`, so the ceiling is a
  // max-width on the row rather than a second track argument.
  assert.match(dockStyles, /max-width: var\(--prompt-max-width\)/);
  assert.doesNotMatch(dockStyles, /minmax\([^)]*fit-content/);
});

test("the detected-system footnote aligns on baselines, not boxes", () => {
  // Three font sizes on one line: centring their boxes leaves the smallest
  // visibly riding high against the rest.
  assert.match(localModelStyles, /\.detectedSystem \{[\s\S]{0,320}align-items: baseline/);
});

test("the dictation collection is shown flat, not behind a dropdown", () => {
  assert.match(localModelList, /export function DictationModelList/);
  assert.match(localModelList, /role="radiogroup"/);
  assert.doesNotMatch(voiceSettings, /LocalModelMenu/);
});

test("a quantization menu opens above the settings scrim it was opened from", () => {
  // Portalled to <body> to escape the scrolling model menu, which also takes it
  // out of the scrim's subtree — without a higher layer it opens behind it.
  const scrim = read("../src/renderer/styles/review.css");
  const scrimLayer = Number(/\.modalScrim \{[\s\S]*?z-index: (\d+)/.exec(scrim)?.[1]);
  const menuLayer = Number(/\.quantPickerMenu \{[\s\S]*?z-index: (\d+)/.exec(localModelStyles)?.[1]);
  assert.ok(Number.isFinite(scrimLayer) && Number.isFinite(menuLayer));
  assert.ok(menuLayer > scrimLayer, `quant menu (${menuLayer}) must paint above the scrim (${scrimLayer})`);
  // And each quantization says whether choosing it costs a download.
  assert.match(localModelList, /entry\.downloaded \? "On disk" : "Download"/);
});

test("a loading model keeps its name instead of being replaced by a sentence", () => {
  assert.doesNotMatch(localModelList, /`Loading \$\{/);
  assert.match(localModelList, /className="modelPickerLoadingNote"/);
  assert.match(localModelStyles, /\.modelPickerLoadingNote \{/);
});
