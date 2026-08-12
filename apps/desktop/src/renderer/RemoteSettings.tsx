import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  KeyRound,
  Loader2,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import type {
  DesktopApi,
  RemoteAuthMethod,
  RemoteConnectionInfo,
} from "../shared/desktopApi";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";

/**
 * Sets up the machines Umbratic can run on.
 *
 * The page is ordered the way the work has to happen: describe the host, look
 * at its key and decide to trust it, install the runner, then choose where runs
 * start. Each step is only offered once the one before it is done, because
 * every one of them depends on the last — there is nothing to install on a host
 * whose identity has not been checked.
 */

const blankDraft = {
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authMethod: "agent" as RemoteAuthMethod,
  identityFilePath: "",
  password: "",
};

type RemoteDraft = typeof blankDraft;

type PendingAction = "" | "saving" | "checking" | "trusting" | "installing";

function draftFrom(connection: RemoteConnectionInfo): RemoteDraft {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    identityFilePath: connection.identityFilePath,
    password: "",
  };
}

/**
 * Owns the saved remote hosts for the whole window, not just for the settings
 * page. The composer needs the same list to offer a host at all, so it loads
 * once on mount and refreshes whenever the settings page is opened — where the
 * list is the thing being changed.
 */
export function useRemoteSettings({ api, active }: { api: DesktopApi; active: boolean }) {
  const [connections, setConnections] = useState<RemoteConnectionInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<RemoteDraft>(blankDraft);
  const [pending, setPending] = useState<PendingAction>("");
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [hostKeyOffer, setHostKeyOffer] = useState<{ fingerprint: string; keyType: string } | null>(null);
  const [installPrompt, setInstallPrompt] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // A blank draft looks exactly like "nothing chosen", so the form has to be
  // told it was asked for rather than inferring it from the fields.
  const [creating, setCreating] = useState(false);

  const selected = connections.find((connection) => connection.id === selectedId) ?? null;

  async function refresh(): Promise<RemoteConnectionInfo[]> {
    const next = await api.listRemoteConnections();
    setConnections(next);
    return next;
  }

  useEffect(() => {
    if (loaded && !active) return;
    setLoaded(true);
    void refresh().catch(() => undefined);
    // `refresh` is stable for this component's lifetime; re-running on identity
    // would reload the list on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loaded]);

  function select(connection: RemoteConnectionInfo | null) {
    setSelectedId(connection?.id ?? "");
    setDraft(connection ? draftFrom(connection) : blankDraft);
    setCreating(false);
    setMessage(null);
    setHostKeyOffer(null);
    setInstallPrompt(false);
    setBrowsing(false);
  }

  async function run<T>(action: PendingAction, work: () => Promise<T>): Promise<T | null> {
    setPending(action);
    setMessage(null);
    try {
      return await work();
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
      return null;
    } finally {
      setPending("");
    }
  }

  return {
    connections,
    selected,
    draft,
    pending,
    message,
    hostKeyOffer,
    installPrompt,
    browsing,
    creating,
    setDraft,
    setBrowsing,
    setInstallPrompt,
    select,
    startNew() {
      select(null);
      setCreating(true);
    },
    async save() {
      const saved = await run("saving", async () => {
        const connection = await api.saveRemoteConnection({
          id: draft.id || undefined,
          name: draft.name,
          host: draft.host,
          port: Number(draft.port),
          username: draft.username,
          authMethod: draft.authMethod,
          identityFilePath: draft.identityFilePath,
          password: draft.password,
          defaultDirectory: selected?.defaultDirectory,
        });
        await refresh();
        return connection;
      });
      if (!saved) return;
      setSelectedId(saved.id);
      setDraft(draftFrom(saved));
      setCreating(false);
      setMessage({ tone: "ok", text: "Saved." });
    },
    async remove(connectionId: string) {
      await run("saving", async () => {
        await api.deleteRemoteConnection({ connectionId });
        await refresh();
      });
      select(null);
    },
    async chooseIdentityFile() {
      const chosen = await api.pickRemoteIdentityFile().catch(() => ({ path: "" }));
      if (chosen.path) setDraft((current) => ({ ...current, identityFilePath: chosen.path }));
    },
    async reviewHostKey() {
      if (!selected) return;
      const offer = await run("trusting", () => api.offerRemoteHostKey({ connectionId: selected.id }));
      if (offer) setHostKeyOffer({ fingerprint: offer.fingerprint, keyType: offer.keyType });
    },
    async trustHostKey() {
      if (!selected || !hostKeyOffer) return;
      const trusted = await run("trusting", async () => {
        const connection = await api.trustRemoteHostKey({
          connectionId: selected.id,
          fingerprint: hostKeyOffer.fingerprint,
        });
        await refresh();
        return connection;
      });
      if (!trusted) return;
      setHostKeyOffer(null);
      setMessage({ tone: "ok", text: "Host key trusted." });
    },
    async check() {
      if (!selected) return;
      const result = await run("checking", async () => {
        const check = await api.checkRemoteConnection({ connectionId: selected.id });
        await refresh();
        return check;
      });
      if (result) setMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
    },
    async install() {
      if (!selected) return;
      const result = await run("installing", async () => {
        const check = await api.installRemoteRunner({ connectionId: selected.id });
        await refresh();
        return check;
      });
      setInstallPrompt(false);
      if (result) setMessage({ tone: result.ok ? "ok" : "warn", text: result.message });
    },
    browse: (path: string) =>
      api.browseRemoteDirectory({ connectionId: selectedId, path }),
    async chooseDefaultDirectory(path: string) {
      if (!selectedId) return;
      await run("saving", async () => {
        await api.setRemoteDefaultDirectory({ connectionId: selectedId, path });
        await refresh();
      });
      setBrowsing(false);
    },
  };
}

export type RemoteSettingsController = ReturnType<typeof useRemoteSettings>;

function runnerStatusLabel(connection: RemoteConnectionInfo): string {
  if (!connection.hostKeyFingerprint) return "Host key not reviewed";
  switch (connection.runnerState) {
    case "ready":
      return "Runner installed";
    case "outdated":
      return "Runner needs reinstalling";
    case "missing":
      return "Runner not installed";
    default:
      return "Not checked yet";
  }
}

function statusTone(connection: RemoteConnectionInfo): string {
  if (!connection.hostKeyFingerprint) return "isWarn";
  return connection.runnerState === "ready" ? "isReady" : "isWarn";
}

export function RemoteSettingsPanel({ controller }: { controller: RemoteSettingsController }) {
  const {
    connections,
    selected,
    draft,
    pending,
    message,
    hostKeyOffer,
    installPrompt,
    browsing,
    creating,
    setDraft,
    setBrowsing,
    setInstallPrompt,
  } = controller;
  const editing = creating || selected !== null;

  return (
    <div className="settingsPanel remoteSettings">
      <div className="settingsPanelHead">
        <h3>Remote connections</h3>
        <p>
          Run Umbratic&rsquo;s workspace tools on another machine over SSH. The model still answers from this
          computer; only the files and commands are that host&rsquo;s.
        </p>
      </div>

      <div className="settingsGroup">
        <h4>Saved hosts</h4>
        {connections.length === 0 ? (
          <p className="remoteEmpty">No remote hosts yet.</p>
        ) : (
          <div className="settingsList remoteList">
            {connections.map((connection) => (
              <button
                key={connection.id}
                type="button"
                className={`remoteListRow ${connection.id === selected?.id ? "isActive" : ""}`}
                onClick={() => controller.select(connection)}
              >
                <Server size={15} aria-hidden="true" />
                <span className="remoteListName">
                  <strong>{connection.name}</strong>
                  <em>
                    {connection.username}@{connection.host}
                    {connection.port === 22 ? "" : `:${connection.port}`}
                  </em>
                </span>
                <span className={`remoteStatus ${statusTone(connection)}`}>{runnerStatusLabel(connection)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="settingsActionsRow">
          <button className="secondaryAction" type="button" onClick={controller.startNew}>
            <Plus size={14} aria-hidden="true" />
            Add a remote
          </button>
        </div>
      </div>

      {editing ? (
        <div className="settingsGroup">
          <h4>{selected ? "Connection" : "New connection"}</h4>
          <label className="settingsField">
            <span>Name</span>
            <input
              value={draft.name}
              placeholder="Build box"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="remoteFieldRow">
            <label className="settingsField">
              <span>Host</span>
              <input
                value={draft.host}
                placeholder="build.example.com"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
              />
            </label>
            <label className="settingsField remoteFieldPort">
              <span>Port</span>
              <input
                value={String(draft.port)}
                inputMode="numeric"
                onChange={(event) => setDraft({ ...draft, port: Number(event.target.value.replace(/\D/g, "")) || 0 })}
              />
            </label>
          </div>
          <label className="settingsField">
            <span>User name</span>
            <input
              value={draft.username}
              placeholder="carmine"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            />
          </label>
          <label className="settingsField">
            <span>Sign in with</span>
            <select
              value={draft.authMethod}
              onChange={(event) => setDraft({ ...draft, authMethod: event.target.value as RemoteAuthMethod })}
            >
              <option value="agent">SSH agent</option>
              <option value="identity_file">Private key file</option>
              <option value="password">Password</option>
            </select>
          </label>

          {draft.authMethod === "identity_file" ? (
            <label className="settingsField">
              <span>Private key</span>
              <div className="remoteFileField">
                <input
                  value={draft.identityFilePath}
                  placeholder="No key chosen"
                  readOnly
                  onChange={() => undefined}
                />
                <button className="secondaryAction" type="button" onClick={() => void controller.chooseIdentityFile()}>
                  <KeyRound size={14} aria-hidden="true" />
                  Choose…
                </button>
              </div>
            </label>
          ) : null}

          {draft.authMethod === "password" ? (
            <label className="settingsField">
              <span>Password</span>
              <input
                type="password"
                value={draft.password}
                placeholder={selected?.passwordConfigured ? "Saved — type to replace" : "Required"}
                autoComplete="off"
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
              <small className="remoteFieldNote">
                Stored with your operating system&rsquo;s secure storage and handed to SSH only while it connects. A
                key is safer where the host allows one.
              </small>
            </label>
          ) : null}

          <div className="settingsActionsRow">
            <button className="primaryAction" type="button" disabled={pending !== ""} onClick={() => void controller.save()}>
              {pending === "saving" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
              Save
            </button>
            {selected ? (
              <button
                className="secondaryAction remoteDanger"
                type="button"
                disabled={pending !== ""}
                onClick={() => void controller.remove(selected.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {selected ? (
        <div className="settingsGroup">
          <h4>Host key</h4>
          {selected.hostKeyFingerprint ? (
            <div className="remoteKeyRow">
              <ShieldCheck className="remoteKeyIcon isReady" size={16} aria-hidden="true" />
              <span>
                <strong>Trusted {selected.hostKeyType}</strong>
                <code>{selected.hostKeyFingerprint}</code>
              </span>
            </div>
          ) : hostKeyOffer ? (
            <div className="remoteKeyOffer">
              <AlertTriangle className="remoteKeyIcon isWarn" size={16} aria-hidden="true" />
              <div>
                <strong>Confirm this is the right host</strong>
                <p>Compare this fingerprint with the one the host reports before trusting it.</p>
                <code>{hostKeyOffer.fingerprint}</code>
                <p className="remoteKeyType">{hostKeyOffer.keyType} key</p>
              </div>
              <button
                className="primaryAction"
                type="button"
                disabled={pending !== ""}
                onClick={() => void controller.trustHostKey()}
              >
                Trust this host
              </button>
            </div>
          ) : (
            <>
              <p className="remoteFieldNote">
                Nothing has been sent to this host yet. Read its key first; credentials are only offered to a host
                you have trusted.
              </p>
              <div className="settingsActionsRow">
                <button
                  className="secondaryAction"
                  type="button"
                  disabled={pending !== ""}
                  onClick={() => void controller.reviewHostKey()}
                >
                  {pending === "trusting" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
                  Read host key
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {selected?.hostKeyFingerprint ? (
        <div className="settingsGroup">
          <h4>Runner</h4>
          <div className="settingsList">
            <div className="settingsListRow">
              <span>Status</span>
              <strong>{runnerStatusLabel(selected)}</strong>
            </div>
            {selected.platform.os ? (
              <div className="settingsListRow">
                <span>Host</span>
                <strong>
                  {selected.platform.os} {selected.platform.arch}
                </strong>
              </div>
            ) : null}
            {selected.runnerPath ? (
              <div className="settingsListRow">
                <span>Installed at</span>
                <strong className="settingsPathText">{selected.runnerPath}</strong>
              </div>
            ) : null}
          </div>

          {installPrompt ? (
            <div className="remoteConfirm">
              <Download size={16} aria-hidden="true" />
              <div>
                <strong>Install the Umbratic runner on {selected.name}?</strong>
                <p>
                  This copies one executable into <code>~/.umbratic/bin</code> on that host and runs it there when a
                  chat uses this connection. Nothing else on the host is changed.
                </p>
              </div>
              <div className="remoteConfirmActions">
                <button className="secondaryAction" type="button" onClick={() => setInstallPrompt(false)}>
                  Cancel
                </button>
                <button
                  className="primaryAction"
                  type="button"
                  disabled={pending !== ""}
                  onClick={() => void controller.install()}
                >
                  {pending === "installing" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
                  Install runner
                </button>
              </div>
            </div>
          ) : (
            <div className="settingsActionsRow">
              <button
                className="secondaryAction"
                type="button"
                disabled={pending !== ""}
                onClick={() => void controller.check()}
              >
                {pending === "checking" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null}
                Test connection
              </button>
              <button className="primaryAction" type="button" disabled={pending !== ""} onClick={() => setInstallPrompt(true)}>
                <Download size={14} aria-hidden="true" />
                {selected.runnerState === "ready" ? "Reinstall runner" : "Install runner"}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {selected?.hostKeyFingerprint ? (
        <div className="settingsGroup">
          <h4>Default folder</h4>
          <div className="settingsList">
            <div className="settingsListRow">
              <span>Runs start in</span>
              <strong className="settingsPathText">{selected.defaultDirectory || "the sign-in home folder"}</strong>
            </div>
          </div>
          {browsing ? (
            <RemoteFolderBrowser
              title={selected.name}
              initialPath={selected.defaultDirectory}
              onBrowse={controller.browse}
              onChoose={(path) => void controller.chooseDefaultDirectory(path)}
            />
          ) : (
            <div className="settingsActionsRow">
              <button className="secondaryAction" type="button" onClick={() => setBrowsing(true)}>
                <FolderOpen size={14} aria-hidden="true" />
                Browse folders
              </button>
            </div>
          )}
        </div>
      ) : null}

      {message ? (
        <div className={`remoteMessage ${message.tone}`} role="status" aria-live="polite">
          {message.tone === "ok" ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <AlertTriangle size={15} aria-hidden="true" />
          )}
          <span>{message.text}</span>
        </div>
      ) : null}
    </div>
  );
}
