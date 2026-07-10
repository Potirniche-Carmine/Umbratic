import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { loadTypeScriptModule } from "./helpers/load-ts-module.mjs";

const policy = loadTypeScriptModule(new URL("../src/policy.ts", import.meta.url).pathname);

test("generated and blocked paths cover real workspace artifacts and secrets", () => {
  assert.equal(policy.isGeneratedRuntimePath("node_modules/react/index.js"), true);
  assert.equal(policy.isGeneratedRuntimePath(".umbratic/build/CMakeCache.txt"), true);
  assert.equal(policy.isGeneratedRuntimePath(".DS_Store"), true);
  assert.equal(policy.isGeneratedRuntimePath("docs/Thumbs.db"), true);
  assert.equal(policy.isGeneratedRuntimePath("src/main.ts"), false);

  assert.equal(policy.isBlockedPath(".env.production"), true);
  assert.equal(policy.isBlockedPath("certs/server.pem"), true);
  assert.equal(policy.isBlockedPath("docs/token-rotation.md"), true);
  assert.equal(policy.isBlockedPath("src/config.example.ts"), false);
});

test("command classification distinguishes safe reads from risky mutations", () => {
  const cwd = path.join(os.tmpdir(), "umbratic-runner-policy");
  const cases = [
    ["git status --short", "git-read", false],
    ["git diff -- README.md", "git-read", false],
    ["git commit -am update", "git-write", true],
    ["git reset --hard HEAD", "destructive-file", true],
    ["git clean -fd", "destructive-file", true],
    ["curl https://example.test", "network", true],
    ["npm install left-pad", "package-manager", true],
    ["npm run test", "package-manager", false],
    ["uv run python tests.py", "python-runtime", false],
    ["python script.py", "python-runtime", false],
    ["python3 script.py", "python-runtime", false],
    ["py script.py", "python-runtime", false],
    ["rg TODO src", "shell", false],
  ];

  for (const [command, commandClass, risky] of cases) {
    const got = policy.classifyCommandText(command, cwd);
    assert.equal(got.commandClass, commandClass, command);
    assert.equal(got.risky, risky, command);
  }
});

test("external absolute paths are blocked when a command escapes the workspace", () => {
  const cwd = path.join(os.tmpdir(), "umbratic-runner-policy-workspace");
  const external = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
  const got = policy.classifyCommandText(`type ${external}`, cwd);
  assert.equal(got.commandClass, "external-directory");
  assert.equal(got.risky, true);

  const quoted = policy.classifyCommandText(process.platform === "win32" ? `type "${external}"` : `cat "${external}"`, cwd);
  assert.equal(quoted.commandClass, "external-directory");
  assert.equal(quoted.risky, true);

  const inside = path.join(cwd, "src", "app.ts");
  const safe = policy.classifyCommandText(process.platform === "win32" ? `type "${inside}"` : `cat "${inside}"`, cwd);
  assert.equal(safe.commandClass, "read");
  assert.equal(safe.risky, false);
});

test("redaction removes common secrets and clips long telemetry text", () => {
  const redacted = policy.redactText([
    "api_key=sk-test-1234567890abcd",
    "token: ghp_abcdefghijklmnopqrstuvwxyz123456",
    "bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "AKIA1234567890ABCDEF",
  ].join("\n"));

  assert.match(redacted, /api_key=\[redacted\]/);
  assert.match(redacted, /token=\[redacted\]/);
  assert.match(redacted, /\[redacted-github-token\]/);
  assert.match(redacted, /\[redacted-aws-key\]/);
  assert.doesNotMatch(redacted, /sk-test-1234567890abcd/);

  const clipped = policy.redactText("x".repeat(50), 12);
  assert.equal(clipped, "xxxxxxxxxxxx...[truncated]");
});
