import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const { encodeProviderMessages, providerCapabilities } = loadTypeScriptModule(new URL("../src/provider/historyEncoder.ts", import.meta.url).pathname, { cache: new Map() });

test("provider capabilities select structured and fallback history explicitly", () => {
  assert.equal(providerCapabilities("https://models.example/v1/chat/completions").structuredToolHistory, true);
  assert.equal(providerCapabilities("http://127.0.0.1:11434/api/chat").structuredToolHistory, false);
  assert.equal(providerCapabilities("https://veil.example/api/engineering/chat").schemaProfile, "veil-compatible");
});

test("Ollama history encoding converts content parts without inspecting synthetic text", () => {
  const capabilities = providerCapabilities("http://127.0.0.1:11434/api/chat");
  const encoded = encodeProviderMessages([{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }], capabilities);
  assert.equal(encoded[0].content, "hello");
});
