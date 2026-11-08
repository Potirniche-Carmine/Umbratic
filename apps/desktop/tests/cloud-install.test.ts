import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const source = new URL("../src/main/cloudInstall.ts", import.meta.url);
const installer = loadTypeScriptModule(source, { realm: "host" });

test("installer plans are fixed vendor commands with no renderer-provided URLs or shell text", () => {
  assert.equal(installer.cloudInstallPlan("codex", "darwin").url, "https://chatgpt.com/codex/install.sh");
  assert.equal(installer.cloudInstallPlan("claude", "linux").executable, "/bin/bash");
  const windows = installer.cloudInstallPlan("codex", "win32");
  assert.equal(windows.url, "https://chatgpt.com/codex/install.ps1");
  assert.equal(windows.args.at(-1), "-File");
  assert.throws(() => installer.cloudInstallPlan("codex; echo unsafe"));
  assert.throws(() => installer.cloudInstallPlan("claude", "freebsd"));
});

test("downloads follow only the provider's verified redirect and reject HTML, failures and oversized responses", async () => {
  const calls = [];
  const module = loadTypeScriptModule(source, { realm: "host", globals: { fetch: async (url, options) => {
    calls.push([url, options.redirect]);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://releases.openai.com/codex/install.sh" } }) : new Response("#!/bin/sh\necho official");
  } } });
  assert.match(await module.downloadCloudInstaller("https://chatgpt.com/codex/install.sh", new AbortController().signal), /official/);
  assert.deepEqual(calls, [["https://chatgpt.com/codex/install.sh", "manual"], ["https://releases.openai.com/codex/install.sh", "error"]]);
  await assert.rejects(() => module.downloadCloudInstaller("https://example.com/install.sh", new AbortController().signal), /Unsupported/);
  for (const response of [
    new Response(null, { status: 302, headers: { location: "https://example.com/untrusted.sh" } }),
    new Response("<!doctype html><title>Sign in</title>"),
    new Response("unavailable", { status: 503 }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const rejected = loadTypeScriptModule(source, { realm: "host", globals: { fetch: async () => response } });
    await assert.rejects(() => rejected.downloadCloudInstaller("https://claude.ai/install.sh", new AbortController().signal));
  }
});

for (const platform of ["darwin", "linux", "win32"]) {
  for (const provider of ["codex", "claude"]) {
    test(`${provider} installation on ${platform} preserves the script, serializes requests, and cleans temporary files`, { timeout: 5000 }, async () => {
      const spawned = Promise.withResolvers();
      const script = "# fixture only, never executed\n";
      const module = loadTypeScriptModule(source, { realm: "host", globals: {
        process: { platform, env: process.env },
        fetch: async () => new Response(script),
      }, mocks: {
        "node:child_process": { spawn: (command, args, options) => {
          const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          spawned.resolve({ child, command, args, options });
          return child;
        } },
      } });
      const pending = module.installOfficialCloudRuntime(provider);
      // Observe early failures as well as spawn: an assertion must never leave
      // this test spinning forever while the installation promise rejects.
      const ready = Promise.race([spawned.promise, pending.then(() => {
        throw new Error("Installation completed without spawning the installer");
      })]);
      let installedPath;
      const { child, command, args, options } = await ready;
      try {
        assert.equal(module.cloudInstallInProgress(), true);
        await assert.rejects(() => module.installOfficialCloudRuntime(provider), /already running/);
        installedPath = args.at(-1);
        assert.equal(fs.readFileSync(installedPath, "utf8"), script);
        if (platform === "win32") {
          assert.match(command, /[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
          assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
          assert.match(installedPath, /install\.ps1$/);
        } else {
          assert.equal(command, provider === "codex" ? "/bin/sh" : "/bin/bash");
          assert.equal(args.length, 1);
          assert.match(installedPath, /install\.sh$/);
        }
        assert.equal(options.shell, false);
        assert.equal(options.env.CODEX_NON_INTERACTIVE, "1");
        assert.equal(options.detached, platform !== "win32");
      } finally {
        child.emit("close", 0);
        await pending;
      }
      assert.equal(module.cloudInstallInProgress(), false);
      assert.equal(fs.existsSync(installedPath), false);
    });
  }
}

test("installer failures release the lock and surface actionable output", async () => {
  const module = loadTypeScriptModule(source, { realm: "host", globals: { fetch: async () => new Response("#!/bin/sh\n") }, mocks: {
    "node:child_process": { spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setImmediate(() => { child.stderr.emit("data", Buffer.from("Network unavailable")); child.emit("close", 1); });
      return child;
    } },
  } });
  await assert.rejects(() => module.installOfficialCloudRuntime("codex"), /Network unavailable/);
  assert.equal(module.cloudInstallInProgress(), false);
});
