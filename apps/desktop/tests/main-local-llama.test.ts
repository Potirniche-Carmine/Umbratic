import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const localLlama = loadTypeScriptModule(new URL("../src/main/localLlama.ts", import.meta.url));
const llamaServerSource = fs.readFileSync(new URL("../src/main/llamaServer.ts", import.meta.url), "utf8");
const childShutdownSource = fs.readFileSync(new URL("../src/main/childShutdown.ts", import.meta.url), "utf8");

test("the chat sidecar is launched with the weights, the whole context, and one slot", () => {
  const args = localLlama.localLlamaArgs({ modelFile: "/models/gemma4-e2b.gguf", modelId: "gemma4-e2b", projectorFile: null, contextLength: 64000, mtp: null });

  assert.deepEqual([...args], [
    "-m", "/models/gemma4-e2b.gguf",
    // The alias is what Veil finds the model under: without it llama-server
    // advertises the weights file path and Veil's health answers 503 forever.
    "--alias", "gemma4-e2b",
    "--ctx-size", "64000",
    "--jinja",
    "--parallel", "1",
    "--no-webui",
    "--offline",
  ]);
  // --jinja is what makes llama.cpp parse tool calls out of the chat template
  // rather than leaving them in the content stream as prose.
  assert.ok(args.includes("--jinja"));
  // llama.cpp divides the context between slots, so a second slot would halve
  // the context the user configured without saying so.
  assert.equal(args[args.indexOf("--parallel") + 1], "1");
});

test("a model with an MTP head drafts from it when asked, naming a separate head as the draft model", () => {
  const base = { modelFile: "/models/qwen38-27b.gguf", modelId: "qwen38-27b", projectorFile: null, contextLength: 64000 };
  // The head is inside the weights: llama-server is told to draft and finds it there.
  const embedded = localLlama.localLlamaArgs({ ...base, mtp: { draftFile: null } });
  assert.deepEqual([...embedded.slice(-4)], ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]);
  assert.ok(!embedded.includes("--model-draft"));
  // The head is its own file: it is named, and still drafted from.
  const sidecar = localLlama.localLlamaArgs({ ...base, mtp: { draftFile: "/models/mtp-qwen38-27b.gguf" } });
  assert.deepEqual([...sidecar.slice(-6)], ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2", "--model-draft", "/models/mtp-qwen38-27b.gguf"]);
  // Off, or a model without a head, decodes one token at a time.
  assert.ok(!localLlama.localLlamaArgs({ ...base, mtp: null }).includes("--spec-type"));
});

test("a missing or unconfigured model sends the user to the connection panel, not to a stack trace", async () => {
  await assert.rejects(
    () => localLlama.ensureLocalLlama({ modelFile: "", modelId: "gemma4-e2b", projectorFile: null, contextLength: 64000, mtp: null }),
    /Download a model in Settings/,
  );
  await assert.rejects(
    () => localLlama.ensureLocalLlama({ modelFile: path.join(os.tmpdir(), "umbratic-absent.gguf"), modelId: "gemma4-e2b", projectorFile: null, contextLength: 64000, mtp: null }),
    /Download a model in Settings/,
  );

  const present = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-llama-")), "weights.gguf");
  fs.writeFileSync(present, "");
  await assert.rejects(
    () => localLlama.ensureLocalLlama({ modelFile: present, modelId: "", projectorFile: null, contextLength: 64000, mtp: null }),
    /Download a model in Settings/,
  );
  await assert.rejects(
    () => localLlama.ensureLocalLlama({ modelFile: present, modelId: "gemma4-e2b", projectorFile: null, contextLength: 0, mtp: null }),
    /context length is not configured/,
  );
});

test("the supervisor binds loopback, authenticates, and never inherits the app environment", () => {
  assert.match(llamaServerSource, /"--host", "127\.0\.0\.1"/);
  assert.match(llamaServerSource, /env\.LLAMA_API_KEY = apiKey/);
  assert.doesNotMatch(llamaServerSource, /"--api-key"/);
  assert.match(llamaServerSource, /crypto\.randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(llamaServerSource, /probe\.listen\(0, "127\.0\.0\.1"/);
  assert.equal(llamaServerSource.includes("...process.env"), false);
  // No shell: the model file path is an argument, never a command string.
  assert.doesNotMatch(llamaServerSource, /shell:\s*true/);
});

test("the supervisor resolves only the packaged binary or an explicit override", () => {
  const start = llamaServerSource.indexOf("export function llamaServerBinaryPath");
  const resolver = llamaServerSource.slice(start, llamaServerSource.indexOf("\n}", start));
  assert.match(resolver, /\.resourcesPath/);
  assert.match(resolver, /UMBRATIC_LLAMA_SERVER/);
  assert.match(resolver, /llama-server binary is missing/);
  // Nothing found on PATH: an unreviewed runtime must never be used.
  assert.doesNotMatch(resolver, /\bPATH\b/);
});

test("a sidecar that will not stay up is backed off rather than respawned in a loop", () => {
  assert.match(llamaServerSource, /respawnBaseDelayMs = 1_000/);
  assert.match(llamaServerSource, /respawnMaxDelayMs = 30_000/);
  assert.match(llamaServerSource, /Math\.min\(respawnBaseDelayMs \* 2 \*\* \(failures - 1\), respawnMaxDelayMs\)/);
  assert.match(childShutdownSource, /spawn\("taskkill", \["\/pid", String\(child\.pid\), "\/t", "\/f"\]/);
});

test("the sidecar's own output stays in diagnostics, never in a renderer-visible message", () => {
  assert.match(llamaServerSource, /output: output\.trim\(\)\.slice\(-2000\)/);
  assert.match(llamaServerSource, /event: `\$\{options\.label\}\.start_failed`/);
  // The exit code rides along, and a start killed by a newer settings change
  // is not reported as a failure at all.
  assert.match(llamaServerSource, /exitCode: exitDetail\.code/);
  assert.match(llamaServerSource, /const superseded = stopRequested\(child\)/);
  // Every message this module throws is assembled from readiness state alone.
  // The runtime's own output names file paths and arguments, so it is never
  // interpolated into anything a person will be shown.
  const thrown = [...llamaServerSource.matchAll(/new Error\(\s*((?:`[^`]*`|"[^"]*")(?:\s*\+\s*`[^`]*`)*)/g)]
    .map((match) => match[1]);
  assert.ok(thrown.some((message) => message.includes("did not become ready within")));
  assert.ok(thrown.some((message) => message.includes("exited before it was ready")));
  for (const message of thrown) assert.equal(message.includes("${output"), false);
});

test("vision loads a paired projector and rejects a missing encoder before starting", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-vision-"));
  try {
    const modelFile = path.join(directory, "weights.gguf");
    fs.writeFileSync(modelFile, "weights");
    const request = { modelFile, projectorFile: path.join(directory, "mmproj.gguf"), modelId: "vision", contextLength: 4096, mtp: null };
    const args = localLlama.localLlamaArgs(request);
    assert.equal(args[args.indexOf("--mmproj") + 1], request.projectorFile);
    await assert.rejects(() => localLlama.ensureLocalLlama(request), /Download a model/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
