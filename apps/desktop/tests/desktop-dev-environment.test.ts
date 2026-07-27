import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { prepareRendererDevelopmentEnvironment } from "../scripts/devEnvironment.ts";

test("desktop development restores the renderer environment after production builds", () => {
  const environment: Record<string, string | undefined> = {
    NODE_ENV: "production",
  };

  prepareRendererDevelopmentEnvironment(environment);

  assert.equal(environment.NODE_ENV, "development");
});

test("desktop development restores the renderer environment before Vite starts", () => {
  const source = readFileSync(
    new URL("../scripts/dev.ts", import.meta.url),
    "utf8",
  );
  const build = source.indexOf("await buildDesktopProcessFiles()");
  const restore = source.indexOf(
    "prepareRendererDevelopmentEnvironment(process.env)",
  );
  const serve = source.indexOf("await createServer(");

  assert.ok(build >= 0);
  assert.ok(restore > build);
  assert.ok(serve > restore);
});
