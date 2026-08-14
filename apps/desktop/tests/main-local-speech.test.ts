import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const localSpeech = loadTypeScriptModule(new URL("../src/main/localSpeech.ts", import.meta.url));
const localSpeechSource = fs.readFileSync(new URL("../src/main/localSpeech.ts", import.meta.url), "utf8");
const dictationSource = fs.readFileSync(new URL("../src/main/dictation.ts", import.meta.url), "utf8");
const localVeil = loadTypeScriptModule(new URL("../src/main/localVeil.ts", import.meta.url));

test("the dictation sidecar is launched with its projector and a small context", () => {
  const args = localSpeech.localSpeechArgs({
    modelFile: "/models/asr.gguf",
    projectorFile: "/models/mmproj-asr.gguf",
    modelId: "qwen3-asr-0.6b",
  });
  assert.deepEqual([...args], [
    "-m", "/models/asr.gguf",
    // Veil names this model in its transcription requests; the alias is what
    // makes the sidecar answer to that name.
    "--alias", "qwen3-asr-0.6b",
    "--mmproj", "/models/mmproj-asr.gguf",
    "--ctx-size", "4096",
    "--parallel", "1",
    "--no-webui",
  ]);
});

test("dictation weights that are not on disk send the user to Voice settings", async () => {
  await assert.rejects(
    () => localSpeech.ensureLocalSpeech({
      modelFile: path.join(os.tmpdir(), "umbratic-absent-asr.gguf"),
      projectorFile: path.join(os.tmpdir(), "umbratic-absent-mmproj.gguf"),
    }),
    /Download a dictation model in Settings/,
  );
});

test("the dictation model is loaded on first press and released when idle", () => {
  // Lazily: an ASR model resident all day costs a gigabyte for a feature most
  // sessions never use.
  assert.match(dictationSource, /const runtime = await ensureLocalSpeech\(/);
  assert.match(dictationSource, /releaseLocalSpeech\(\)/);
  // A minute of not dictating. The countdown only ever starts when a dictation
  // ends and is cleared on the next press, so it cannot cut a long recording.
  assert.equal(localSpeech.speechIdleTimeoutMs, 60 * 1000);
  // The port and key survive the stop, so Veil's configuration stays valid.
  assert.match(localSpeechSource, /supervisor\.endpoint\(\)/);
  assert.doesNotMatch(localSpeechSource, /createLlamaSupervisor\(\{ label: "llama" \}\)/);
});

test("a configured dictation model gives Veil all three speech variables, and none otherwise", () => {
  const base = {
    settings: { mode: "local", baseUrl: "", modelId: "qwen3-8b", secret: "", headers: [] },
    address: "127.0.0.1:0",
    authToken: "t",
    runtime: { baseUrl: "http://127.0.0.1:1", apiKey: "chat-key", reasoning: false },
  };

  const silent = localVeil.localVeilEnvironment(base);
  for (const name of ["VEIL_SPEECH_BASE_URL", "VEIL_SPEECH_MODEL", "VEIL_SPEECH_API_KEY"]) {
    assert.equal(name in silent, false, `${name} must be absent when dictation is off`);
  }

  const speaking = localVeil.localVeilEnvironment({
    ...base,
    runtime: {
      ...base.runtime,
      speech: { baseUrl: "http://127.0.0.1:2", apiKey: "speech-key", model: "qwen3-asr-1.7b" },
    },
  });
  assert.equal(speaking.VEIL_SPEECH_BASE_URL, "http://127.0.0.1:2");
  assert.equal(speaking.VEIL_SPEECH_MODEL, "qwen3-asr-1.7b");
  assert.equal(speaking.VEIL_SPEECH_API_KEY, "speech-key");
  // Still an allowlist: nothing else crept in with them.
  assert.equal(Object.keys(speaking).every((name) => (
    name.startsWith("VEIL_")
    || ["HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL"].includes(name)
  )), true);
});

test("changing the dictation model restarts Veil, which was configured with the old one", () => {
  const source = fs.readFileSync(new URL("../src/main/localVeil.ts", import.meta.url), "utf8");
  const start = source.indexOf("function localVeilKey(");
  assert.match(source.slice(start, source.indexOf("\n}", start)), /speech:/);

  const backend = fs.readFileSync(new URL("../src/main/backendSettings.ts", import.meta.url), "utf8");
  const save = backend.slice(
    backend.indexOf("export async function saveDictationSettings"),
    backend.indexOf("export async function resolveSelectedModel"),
  );
  assert.match(save, /stopLocalSpeech\(\)/);
  assert.match(save, /stopLocalVeil\(\)/);
});
