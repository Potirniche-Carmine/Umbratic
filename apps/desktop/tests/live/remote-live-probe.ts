/**
 * Drives the real main-process remote modules against a live sshd.
 *
 * Not part of `test:unit`: it needs a reachable SSH host, which CI does not
 * have. Run it by hand when changing the remote transport:
 *
 *   UMBRATIC_LIVE_SSH_USER=<user> UMBRATIC_LIVE_SSH_KEY=<path> \
 *   UMBRATIC_LIVE_SSH_PORT=2222 node --test tests/live/remote-live-probe.ts
 *
 * Every assertion goes through the same TypeScript that ships: sshTransport for
 * the connection itself, remoteHost for facts, install, capabilities and the
 * folder listing. Nothing re-implements the wire behaviour it checks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "../helpers/load-ts-module.ts";

const user = process.env.UMBRATIC_LIVE_SSH_USER ?? "";
const keyPath = process.env.UMBRATIC_LIVE_SSH_KEY ?? "";
const port = Number(process.env.UMBRATIC_LIVE_SSH_PORT ?? "2222");
const enabled = user !== "" && keyPath !== "";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-live-remote-"));
const electron = { app: { getPath: () => dataRoot } };
const sshTransport = loadTypeScriptModule(new URL("../../src/main/sshTransport.ts", import.meta.url), {
  mocks: { electron },
});
const remoteHost = loadTypeScriptModule(new URL("../../src/main/remoteHost.ts", import.meta.url), {
  mocks: {
    electron,
    "./remoteConnections": {},
    "./capabilities": loadTypeScriptModule(new URL("../../src/main/capabilities.ts", import.meta.url), {
      mocks: { electron },
    }),
    "./sshTransport": sshTransport,
  },
});

const target = {
  host: "127.0.0.1",
  port,
  username: user,
  authMethod: "identity_file" as const,
  identityFilePath: keyPath,
};

test("live: the first connection pins the host's key into Umbratic's known_hosts", { skip: !enabled }, async () => {
  const knownHosts = sshTransport.knownHostsPath(dataRoot);
  assert.equal(fs.readFileSync(knownHosts, "utf8").trim(), "", "this run starts with nothing pinned");
  await sshTransport.runRemoteCommandOrThrow(target, dataRoot, ["true"]);
  const marker = port === 22 ? "127.0.0.1" : `[127.0.0.1]:${port}`;
  const pinned = fs.readFileSync(knownHosts, "utf8").split("\n").filter(Boolean);
  assert.ok(pinned.some((line: string) => line.split(" ")[0] === marker), pinned.join("\n"));
});

test("live: host facts, runner install, capabilities, and folder listing", { skip: !enabled }, async () => {
  const facts = await remoteHost.probeRemoteHostFacts(target);
  assert.equal(facts.os, "Linux");
  assert.ok(facts.home.startsWith("/"), facts.home);
  assert.equal(remoteHost.remotePlatformKey(facts.os, facts.arch), "linux-x64");

  const artifact = remoteHost.remoteRunnerArtifact("linux-x64");
  assert.ok(artifact, "build the linux-x64 runner into target/remote first");
  const installed = await remoteHost.installRemoteRunner(target, facts);
  assert.equal(installed.sha256, artifact.sha256, "the checksum verified on the far side matches the artifact");
  assert.match(installed.runnerVersion, /UmbraticRunner/);

  const report = await remoteHost.probeRemoteCapabilities(target, installed.runnerVersion);
  const git = report.probes.find((probe: { id: string }) => probe.id === "git");
  assert.equal(git?.status, "available", "the WSL host has git");
  assert.ok(git?.executablePath?.startsWith("/"), "remote paths are the remote host's");

  const listing = await remoteHost.listRemoteDirectory(target, `${facts.home}/remote-workspace`);
  assert.ok(listing.entries.some((entry: { name: string }) => entry.name === "src"));
  assert.equal(listing.parentPath, facts.home);
});

test("live: a changed host key is refused once one is pinned", { skip: !enabled }, async () => {
  // Replacing the pin with someone else's key must make every later command
  // fail with the host-key message, proving `accept-new` still verifies after
  // the first contact rather than accepting whatever answers.
  //
  // The stand-in has to be a real ed25519 key. OpenSSH silently skips a line it
  // cannot parse, which reads as "host not known", and `accept-new` would then
  // pin the true key and the check would prove nothing.
  const marker = port === 22 ? "127.0.0.1" : `[127.0.0.1]:${port}`;
  fs.writeFileSync(
    sshTransport.knownHostsPath(dataRoot),
    `${marker} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzE13G5LItecjKmqRel0XtbVJun5pFgYW9+rGiJyKdQ\n`,
    "utf8",
  );
  await assert.rejects(
    () => remoteHost.probeRemoteHostFacts(target),
    /different key|host key/i,
  );
  // Forgetting it lets the next run pin the real key again from clean.
  sshTransport.forgetHostKey(dataRoot, "127.0.0.1", port);
});
