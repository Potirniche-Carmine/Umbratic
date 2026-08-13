import type { DesktopApi, RemoteConnectionInfo, RemoteDirectoryListing } from "../shared/desktopApi";

/**
 * Remote-host fixtures for the preview harness, which runs the renderer with no
 * Electron and no network. They exist so the remote surfaces can be looked at
 * in both themes and in both of the states that change the composer menu.
 */

export function blankPreviewRemoteConnection(): RemoteConnectionInfo {
  return {
    id: "",
    name: "",
    host: "",
    port: 22,
    username: "",
    authMethod: "agent",
    identityFilePath: "",
    passwordConfigured: false,
    defaultDirectory: "",
    runnerState: "missing",
    runnerVersion: "",
    runnerPath: "",
    platform: { os: "", arch: "" },
  };
}

/**
 * Two hosts in the two states that matter to the composer: one ready to run on
 * and one that still needs setting up, so the menu's enabled and disabled rows
 * can both be seen without a real network.
 */
let connections: RemoteConnectionInfo[] = [
  {
    ...blankPreviewRemoteConnection(),
    id: "remote-build-box",
    name: "Build box",
    host: "build.internal",
    username: "carmine",
    authMethod: "identity_file",
    identityFilePath: "/home/carmine/.ssh/id_ed25519",
    defaultDirectory: "/srv/umbratic",
    runnerState: "ready",
    runnerVersion: "UmbraticRunner rust-1",
    runnerPath: "/home/carmine/.umbratic/bin/umbratic-runner",
    platform: { os: "Linux", arch: "x86_64" },
  },
  {
    ...blankPreviewRemoteConnection(),
    id: "remote-gpu-node",
    name: "GPU node",
    host: "gpu-02.lab",
    port: 2202,
    username: "carmine",
    defaultDirectory: "/data/experiments",
  },
];

const previewRemoteTree: Record<string, string[]> = {
  "/srv/umbratic": ["apps", "packages", "infrastructure", "scripts", "target"],
  "/srv": ["umbratic", "backups", "www"],
  "/srv/umbratic/packages": ["runner", "code-index", "pdf"],
};

export function previewRemoteListing(path: string): RemoteDirectoryListing {
  const resolved = previewRemoteTree[path] ? path : "/srv/umbratic";
  return {
    path: resolved,
    parentPath: resolved.slice(0, resolved.lastIndexOf("/")) || "/",
    entries: (previewRemoteTree[resolved] ?? []).map((name) => ({
      name,
      path: `${resolved}/${name}`,
      kind: "directory" as const,
      unreadable: false,
    })),
    truncated: false,
  };
}

/** The fixture list, as the preview API reads and replaces it. */
export function previewRemoteConnections(): RemoteConnectionInfo[] {
  return connections;
}

export function writePreviewRemoteConnections(next: RemoteConnectionInfo[]): RemoteConnectionInfo[] {
  connections = next;
  return connections;
}

/** The fixture the preview API updates in place, by id. */
export function patchPreviewRemoteConnection(
  connectionId: string,
  patch: Partial<RemoteConnectionInfo>,
): RemoteConnectionInfo {
  connections = connections.map((connection) =>
    connection.id === connectionId ? { ...connection, ...patch } : connection,
  );
  return connections.find((connection) => connection.id === connectionId)!;
}

/**
 * The remote half of the preview desktop API, spread into it whole. Keeping it
 * here keeps the fixtures and the behaviour that reads them in one place.
 */
export const previewRemoteApi: Pick<
  DesktopApi,
  | "listRemoteConnections"
  | "saveRemoteConnection"
  | "deleteRemoteConnection"
  | "checkRemoteConnection"
  | "installRemoteRunner"
  | "browseRemoteDirectory"
  | "setRemoteDefaultDirectory"
  | "pickRemoteIdentityFile"
> = {
  listRemoteConnections: async () => previewRemoteConnections(),
  saveRemoteConnection: async (input) => {
    const existing = previewRemoteConnections().find((connection) => connection.id === input.id);
    const saved = {
      ...(existing ?? blankPreviewRemoteConnection()),
      id: existing?.id ?? `remote-${previewRemoteConnections().length + 1}`,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      identityFilePath: input.identityFilePath ?? "",
      passwordConfigured: Boolean(input.password) || Boolean(existing?.passwordConfigured),
    };
    writePreviewRemoteConnections(
      existing
        ? previewRemoteConnections().map((connection) => (connection.id === saved.id ? saved : connection))
        : [...previewRemoteConnections(), saved],
    );
    return saved;
  },
  deleteRemoteConnection: async (input) => {
    writePreviewRemoteConnections(
      previewRemoteConnections().filter((connection) => connection.id !== input.connectionId),
    );
    return { ok: true } as const;
  },
  checkRemoteConnection: async (input) => {
    const connection = previewRemoteConnections().find((row) => row.id === input.connectionId)!;
    return {
      ok: connection.runnerState === "ready",
      message: connection.runnerState === "ready"
        ? "Connected. The runner is installed and current."
        : "Connected. The runner is not installed on this host yet.",
      connection,
    };
  },
  installRemoteRunner: async (input) => {
    const connection = patchPreviewRemoteConnection(input.connectionId, {
      runnerState: "ready",
      runnerVersion: "UmbraticRunner rust-1",
      runnerPath: "/home/carmine/.umbratic/bin/umbratic-runner",
    });
    return { ok: true, message: `The runner is installed at ${connection.runnerPath}.`, connection };
  },
  browseRemoteDirectory: async (input) => previewRemoteListing(input.path ?? ""),
  setRemoteDefaultDirectory: async (input) =>
    patchPreviewRemoteConnection(input.connectionId, { defaultDirectory: input.path }),
  pickRemoteIdentityFile: async () => ({ path: "/home/carmine/.ssh/id_ed25519" }),
};
