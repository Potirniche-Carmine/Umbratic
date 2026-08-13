import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function temporaryDataRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-remote-test-"));
}

function loadTransport() {
  return loadTypeScriptModule(new URL("../src/main/sshTransport.ts", import.meta.url), {
    mocks: { electron: {} },
  });
}

const target = {
  host: "build.example.com",
  port: 2222,
  username: "carmine",
  authMethod: "identity_file" as const,
  identityFilePath: "/home/carmine/.ssh/id_ed25519",
};

test("remote commands are quoted for the remote shell, never concatenated", () => {
  const { shellQuote, shellCommand } = loadTransport();
  assert.equal(shellQuote("/srv/my project"), "'/srv/my project'");
  // A quote closes the string, escapes a literal quote, and reopens it — the
  // only form a POSIX shell reads back as one argument.
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(
    shellCommand(["ls", "-la", "/srv/a b/c'd"]),
    "'ls' '-la' '/srv/a b/c'\\''d'",
  );
  // The contract is that a remote shell reads back exactly the arguments that
  // were passed, whatever they contain. Checking the output for dangerous text
  // would prove nothing: the text is allowed to appear, inside the quotes.
  for (const argv of [
    ["cd", "/srv'; rm -rf /; echo '"],
    ["ls", "$HOME", "`whoami`", "a\nb", 'say "hi"', "back\\slash"],
    ["sh", "-c", "printf '%s' \"$HOME\"; rm -f 'x y'"],
  ]) {
    assert.deepEqual(splitPosixWords(shellCommand(argv)), argv);
  }
});

/** Word-splits a command line the way a POSIX shell does, for the check above. */
function splitPosixWords(input: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < input.length) {
    if (input[index] === " ") {
      index += 1;
      continue;
    }
    let word = "";
    while (index < input.length && input[index] !== " ") {
      if (input[index] === "'") {
        index += 1;
        while (index < input.length && input[index] !== "'") {
          word += input[index];
          index += 1;
        }
        index += 1;
      } else if (input[index] === "\\") {
        word += input[index + 1] ?? "";
        index += 2;
      } else {
        word += input[index];
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

test("every ssh invocation pins host-key checking to Umbratic's own known_hosts", () => {
  const { sshArguments } = loadTransport();
  const dataRoot = temporaryDataRoot();
  const args = sshArguments(target, dataRoot, [], "true");
  const optionAt = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(args[args.indexOf("-o") + 1], "ConnectTimeout=10");
  // `accept-new` pins on first contact and refuses a changed key afterwards.
  // Anything weaker would accept a different host silently.
  assert.ok(args.includes("StrictHostKeyChecking=accept-new"), args.join(" "));
  assert.ok(!args.includes("StrictHostKeyChecking=no"), args.join(" "));
  assert.ok(
    args.includes(`UserKnownHostsFile=${path.join(dataRoot, "remote", "known_hosts")}`),
    args.join(" "),
  );
  // Multiplexing would outlive this process and orphan the remote runner.
  assert.ok(args.includes("ControlMaster=no"));
  assert.ok(args.includes("ControlPath=none"));
  // Nothing of this machine's is offered to the remote host.
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("ForwardX11=no"));
  assert.equal(optionAt("-p"), "2222");
  assert.equal(optionAt("-i"), target.identityFilePath);
  assert.equal(args.at(-3), "carmine@build.example.com");
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "true");
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("each sign-in method offers only its own credential", () => {
  const { sshArguments } = loadTransport();
  const dataRoot = temporaryDataRoot();
  const argsFor = (authMethod: "agent" | "identity_file" | "password") =>
    sshArguments({ ...target, authMethod }, dataRoot, [], undefined);

  const agent = argsFor("agent");
  assert.ok(agent.includes("PreferredAuthentications=publickey"));
  assert.ok(agent.includes("BatchMode=yes"));
  assert.ok(!agent.includes("-i"));

  const key = argsFor("identity_file");
  assert.ok(key.includes("IdentitiesOnly=yes"), "a key sign-in must not fall back to the agent");

  const password = argsFor("password");
  assert.ok(password.includes("PubkeyAuthentication=no"));
  assert.ok(password.includes("NumberOfPasswordPrompts=1"), "a stored password is offered once, not retried");
  assert.ok(!password.includes("BatchMode=yes"), "batch mode would suppress the prompt the helper answers");
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("a password never reaches a command line and is absent unless it is the method", () => {
  const { sshArguments, sshEnvironment } = loadTransport();
  const dataRoot = temporaryDataRoot();
  const secret = "correct-horse-battery-staple";
  const args = sshArguments({ ...target, authMethod: "password" }, dataRoot, [], "true");
  assert.ok(!args.some((argument) => argument.includes(secret)));

  const passwordEnv = sshEnvironment({ ...target, authMethod: "password" }, dataRoot, secret);
  assert.equal(passwordEnv.UMBRATIC_SSH_PASSWORD, secret);
  assert.equal(passwordEnv.SSH_ASKPASS_REQUIRE, "force");
  assert.ok(typeof passwordEnv.SSH_ASKPASS === "string" && passwordEnv.SSH_ASKPASS.length > 0);
  // The helper reads the secret from the environment, so nothing is written out.
  const helper = fs.readFileSync(passwordEnv.SSH_ASKPASS as string, "utf8");
  assert.ok(!helper.includes(secret), "the askpass helper must not contain the password");

  const keyEnv = sshEnvironment(target, dataRoot, secret);
  assert.equal(keyEnv.UMBRATIC_SSH_PASSWORD, undefined);
  assert.equal(keyEnv.SSH_ASKPASS, undefined);

  assert.throws(
    () => sshEnvironment({ ...target, authMethod: "password" }, dataRoot, ""),
    /no password is stored/,
  );
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("forgetting a host's pinned key leaves every other host's alone", () => {
  const { forgetHostKey, knownHostsPath } = loadTransport();
  const dataRoot = temporaryDataRoot();
  // OpenSSH writes port-22 hosts bare and everything else bracketed, which is
  // what `forgetHostKey` has to match against.
  const pinned = [
    "[build.example.com]:2222 ssh-ed25519 AAAAfirst",
    "other.example.com ssh-ed25519 AAAAsecond",
  ];
  fs.writeFileSync(knownHostsPath(dataRoot), `${pinned.join("\n")}\n`, "utf8");
  const pinnedLines = () =>
    fs.readFileSync(knownHostsPath(dataRoot), "utf8").split("\n").filter(Boolean);

  forgetHostKey(dataRoot, "build.example.com", 2222);
  assert.deepEqual(pinnedLines(), ["other.example.com ssh-ed25519 AAAAsecond"]);
  forgetHostKey(dataRoot, "other.example.com", 22);
  assert.deepEqual(pinnedLines(), []);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("ssh failures are reported as something the user can act on", () => {
  const { remoteFailureMessage } = loadTransport();
  const message = (stderr: string, code: number | null = 255) =>
    remoteFailureMessage({ code, stdout: "", stderr });
  assert.match(message("carmine@host: Permission denied (publickey)."), /refused the credentials/);
  assert.match(message("Host key verification failed."), /different key/);
  assert.match(message("ssh: Could not resolve hostname nope"), /could not be resolved/);
  assert.match(message("ssh: connect to host x port 22: Connection refused"), /did not accept the connection/);
  // The banner OpenSSH writes on a first connection is not the failure.
  assert.match(
    message("Warning: Permanently added 'x' (ED25519) to the list of known hosts.\nPermission denied (publickey)."),
    /refused the credentials/,
  );
  assert.match(message("", 7), /exited with code 7/);
});

test("a Windows remote is answered in plain language, not with a cmd.exe error", async () => {
  // A default Windows sshd hands the probe to cmd.exe, which does not have
  // `sh`. The user should read "this is Windows", not shell output.
  const dataRoot = temporaryDataRoot();
  const remoteHost = loadTypeScriptModule(new URL("../src/main/remoteHost.ts", import.meta.url), {
    mocks: {
      electron: { app: { getPath: () => dataRoot } },
      "./sshTransport": {
        runRemoteCommand: async () => ({
          code: 1,
          stdout: "",
          stderr: "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.",
        }),
        runRemoteCommandOrThrow: async () => "",
        remoteFailureMessage: () => "",
        shellQuote: (value: string) => value,
      },
    },
  });
  await assert.rejects(
    () => remoteHost.probeRemoteHostFacts({ host: "h", port: 22, username: "u", authMethod: "agent" }),
    /looks like Windows/,
  );
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("only platforms with a shipped runner are offered one", () => {
  const remoteHost = loadTypeScriptModule(new URL("../src/main/remoteHost.ts", import.meta.url), {
    mocks: { electron: { app: { getPath: () => temporaryDataRoot() } } },
  });
  assert.equal(remoteHost.remotePlatformKey("Linux", "x86_64"), "linux-x64");
  assert.equal(remoteHost.remotePlatformKey("Linux", "aarch64"), "linux-arm64");
  assert.equal(remoteHost.remotePlatformKey("Darwin", "arm64"), "darwin-arm64");
  assert.equal(remoteHost.remotePlatformKey("MINGW64_NT-10.0", "x86_64"), null);
  assert.equal(remoteHost.remotePlatformKey("Linux", "riscv64"), null);
  assert.equal(remoteHost.remotePlatformKey("", ""), null);
});

test("a remote workspace folder must be an absolute path with no traversal", () => {
  const remoteConnections = loadTypeScriptModule(
    new URL("../src/main/remoteConnections.ts", import.meta.url),
    { mocks: { electron: { app: { getPath: () => temporaryDataRoot() }, safeStorage: { isEncryptionAvailable: () => false } } } },
  );
  const { validatedRemoteDirectory } = remoteConnections;
  assert.equal(validatedRemoteDirectory("/srv/app/"), "/srv/app");
  assert.equal(validatedRemoteDirectory("/"), "/");
  assert.equal(validatedRemoteDirectory("", { allowEmpty: true }), "");
  assert.throws(() => validatedRemoteDirectory("srv/app"), /absolute path/);
  assert.throws(() => validatedRemoteDirectory("/srv/../etc"), /cannot contain/);
  assert.throws(() => validatedRemoteDirectory("/srv/app\0/etc"), /not usable/);
  assert.throws(() => validatedRemoteDirectory(""), /Choose a folder/);
});

test("the renderer is told whether a password exists, never what it is", () => {
  const remoteConnections = loadTypeScriptModule(
    new URL("../src/main/remoteConnections.ts", import.meta.url),
    { mocks: { electron: { app: { getPath: () => temporaryDataRoot() }, safeStorage: { isEncryptionAvailable: () => false } } } },
  );
  const stored = {
    id: "remote_1",
    name: "Build box",
    host: "build.example.com",
    port: 22,
    username: "carmine",
    authMethod: "password",
    identityFilePath: "",
    password: { encoding: "electron-safe-storage-v1", encrypted: "c2VjcmV0" },
    defaultDirectory: "/srv/app",
    runnerPath: "/home/carmine/.umbratic/bin/umbratic-runner",
    runnerSha256: "aaaa",
    runnerVersion: "UmbraticRunner rust-1",
    platformOs: "Linux",
    platformArch: "x86_64",
    lastConnectedAt: "2026-08-11T00:00:00.000Z",
  };
  const publicShape = JSON.parse(JSON.stringify(remoteConnections.publicRemoteConnection(stored, "aaaa")));
  assert.equal(publicShape.passwordConfigured, true);
  assert.equal("password" in publicShape, false);
  assert.ok(!JSON.stringify(publicShape).includes("c2VjcmV0"));
  assert.equal(publicShape.runnerState, "ready");

  // A runner from another build is not the runner this desktop would install.
  assert.equal(remoteConnections.publicRemoteConnection(stored, "bbbb").runnerState, "outdated");
  // With no artifact to compare against, nothing is claimed either way.
  assert.equal(remoteConnections.publicRemoteConnection(stored, "").runnerState, "unknown");
  assert.equal(
    remoteConnections.publicRemoteConnection({ ...stored, runnerSha256: "" }, "aaaa").runnerState,
    "missing",
  );
});
