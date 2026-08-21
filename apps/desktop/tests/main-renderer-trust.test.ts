import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { trustedRendererUrl } = loadTypeScriptModule(new URL("../src/main/rendererTrust.ts", import.meta.url));

const packagedIndexHref = "file:///Applications/Umbratic.app/Contents/Resources/app/dist/index.html";
const trustedDevOrigin = new URL("http://127.0.0.1:5173/");

test("development trusts only the Vite loopback origin", () => {
  const allowed = (rawUrl) =>
    trustedRendererUrl(rawUrl, { isDev: true, trustedDevOrigin, packagedIndexHref });

  assert.equal(allowed("http://127.0.0.1:5173/"), true);
  assert.equal(allowed("http://127.0.0.1:5173/index.html?preview=1"), true);
  assert.equal(allowed("http://127.0.0.1:5174/"), false);
  assert.equal(allowed("http://localhost:5173/"), false);
  assert.equal(allowed("http://0.0.0.0:5173/"), false);
  assert.equal(allowed("https://127.0.0.1:5173/"), false);
  assert.equal(allowed("file:///tmp/index.html"), false);
});

test("a packaged build trusts only the exact renderer file URL", () => {
  const allowed = (rawUrl) =>
    trustedRendererUrl(rawUrl, { isDev: false, trustedDevOrigin, packagedIndexHref });

  assert.equal(allowed(packagedIndexHref), true);
  assert.equal(allowed(`${packagedIndexHref}?x=1`), false);
  assert.equal(allowed("file:///tmp/evil.html"), false);
  assert.equal(allowed("http://127.0.0.1:5173/"), false);
  assert.equal(allowed("javascript:alert(1)"), false);
  assert.equal(allowed(""), false);
  assert.equal(allowed("not a url"), false);
});
