/**
 * Drives the real main-process remote modules against a live sshd.
 *
 * Not part of `test:unit`: it needs a reachable SSH host, which CI does not
 * have. Run it by hand when changing the remote transport:
 *
 *   UMBRATIC_LIVE_SSH_USER=<user> UMBRATIC_LIVE_SSH_KEY=<path> \
 *   UMBRATIC_LIVE_SSH_PORT=2222 node --test tests/live/remote-live-probe.ts
 *
 * Every assertion goes through the same TypeScript that ships: sshTransport
 * for the key scan and trust, remoteHost for facts, install, capabilities and
 * the folder listing. Nothing re-implements the wire behaviour it checks.
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

test("live: host key is read, shown, and trusted before any credential is offered", { skip: !enabled }, async () => {
  const offer = await sshTransport.scanRemoteHostKey(target);
  assert.match(offer.fingerprint, /^SHA256:/);
  assert.equal(offer.keyType, "ED25519");
  sshTransport.trustHostKey(dataRoot, offer.line);
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

test("live: a wrong key is refused before authentication", { skip: !enabled }, async () => {
  // Trusting a garbage key for the host must make every later command fail
  // with the host-key message, proving StrictHostKeyChecking is doing its job.
  const marker = port === 22 ? "127.0.0.1" : `[127.0.0.1]:${port}`;
  sshTransport.trustHostKey(dataRoot, `${marker} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP///////////////////////////////////////w`);
  await assert.rejects(
    () => remoteHost.probeRemoteHostFacts(target),
    /no longer matches|host key/i,
  );
  // Restore the real key so later runs of this file start clean.
  const offer = await sshTransport.scanRemoteHostKey(target);
  sshTransport.trustHostKey(dataRoot, offer.line);
});
