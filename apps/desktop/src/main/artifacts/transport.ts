/**
 * Moving document bytes between this desktop and a remote workspace.
 *
 * There is no engine on the remote host and there is not going to be one — the
 * runner that ships there is a single Rust binary with no Node beside it. So a
 * remote job pulls the input here, builds here, and pushes the result back over
 * the connection the task already uses. The file is on this laptop for the life
 * of the job and nowhere else; it does not pass through any service.
 *
 * Framing is base64 over the SSH command channel rather than a second scp
 * process, so a transfer inherits the connection's existing host-key pinning
 * and credentials instead of opening a new authentication path.
 */

import { app } from "electron";

import { remoteTarget, requireStoredRemoteConnection } from "../remoteConnections";
import { runRemoteCommand, shellQuote } from "../sshTransport";
import type { TaskRecord } from "../types";
import { localTransport, remoteTransport, type ArtifactTransport } from "./service";

/** What a single transfer may carry, matching the engine's own input cap. */
const maxTransferBytes = 64 * 1024 * 1024;

export function localArtifactTransport(workspaceRoot: string): ArtifactTransport {
  return localTransport(workspaceRoot);
}

export function remoteArtifactTransport(task: TaskRecord): ArtifactTransport {
  const remote = task.remote;
  if (!remote) throw new Error("This task is not attached to a remote host.");
  const target = remoteTarget(requireStoredRemoteConnection(remote.connectionId));
  const userDataPath = app.getPath("userData");

  return remoteTransport({
    async pull(absolutePath) {
      const result = await runRemoteCommand(
        target,
        userDataPath,
        [
          "sh",
          "-c",
          [
            "set -eu",
            // The size is checked on the far side so an oversize file is never
            // put on the wire at all.
            `size=$(wc -c < ${shellQuote(absolutePath)})`,
            `if [ "$size" -gt ${maxTransferBytes} ]; then exit 9; fi`,
            `base64 < ${shellQuote(absolutePath)}`,
          ].join("\n"),
        ],
        { timeoutMs: 300_000 },
      );
      if (result.code === 9) {
        throw new Error(
          `${absolutePath} is larger than the ${maxTransferBytes}-byte limit for a document transfer.`,
        );
      }
      if (result.code !== 0) {
        throw new Error(`The remote file could not be read. ${result.stderr.trim()}`.trim());
      }
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    },

    async push(absolutePath, bytes) {
      if (bytes.byteLength > maxTransferBytes) {
        throw new Error(
          `The result is ${bytes.byteLength} bytes, past the ${maxTransferBytes}-byte transfer limit.`,
        );
      }
      const staging = `${absolutePath}.umbratic-incoming`;
      const directory = absolutePath.slice(0, Math.max(0, absolutePath.lastIndexOf("/"))) || ".";
      // Decode to a sibling and rename, so the destination either holds the old
      // file or the complete new one. A connection that drops mid-transfer
      // leaves the staging file, which the next line removes before it writes.
      const result = await runRemoteCommand(
        target,
        userDataPath,
        [
          "sh",
          "-c",
          [
            "set -eu",
            `mkdir -p ${shellQuote(directory)}`,
            `rm -f ${shellQuote(staging)}`,
            "umask 077",
            `base64 -d > ${shellQuote(staging)}`,
            `mv -f ${shellQuote(staging)} ${shellQuote(absolutePath)}`,
          ].join("\n"),
        ],
        { timeoutMs: 300_000, input: Buffer.from(bytes.toString("base64")) },
      );
      if (result.code !== 0) {
        throw new Error(`The result could not be written to the remote host. ${result.stderr.trim()}`.trim());
      }
    },
  });
}
