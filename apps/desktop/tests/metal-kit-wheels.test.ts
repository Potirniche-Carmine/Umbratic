import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("Metal kit wheel patches enforce hashes, preserve identity and reseal RECORD", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", [
    "-B", path.join(root, "infrastructure/veil-console/deploy/test_metal_wheels.py"),
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
});
