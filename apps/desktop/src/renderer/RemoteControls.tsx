import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, Lock, Monitor, Plus, Server } from "lucide-react";

import type { RemoteConnectionInfo, RemoteDirectoryListing } from "../shared/desktopApi";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";

/**
 * Chooses which machine the next run happens on.
 *
 * It sits in the composer row with the other "where and how does this run"
 * controls and borrows their grammar exactly — a pill that opens upward into a
 * menu — because it answers a question of the same kind. Picking a folder on a
 * remote host happens inside the same menu rather than in a dialog: the folder
 * only means anything under the host above it, and a menu is an overlay, so it
 * can grow without moving the composer underneath.
 */

export function remoteConnectionReady(connection: RemoteConnectionInfo): boolean {
  return connection.runnerState === "ready";
}

function unreadyReason(connection: RemoteConnectionInfo): string {
  if (connection.runnerState === "missing") return "Install the runner in settings first";
  if (connection.runnerState === "outdated") return "Reinstall the runner in settings first";
  return "This host cannot run Umbratic yet";
}

/** The last path segment, which is what identifies a folder at a glance. */
function folderLabel(directory: string): string {
  if (!directory || directory === "/") return "/";
  return directory.slice(directory.lastIndexOf("/") + 1) || directory;
}

export function RemoteHostPicker({
  connections,
  selectedId,
  directory,
  disabled,
  locked,
  onSelect,
  onBrowse,
  onManage,
}: {
  connections: RemoteConnectionInfo[];
  /** Empty selects this computer. */
  selectedId: string;
  directory: string;
  disabled: boolean;
  /** True once the chat has started, when the host can no longer change. */
  locked: boolean;
  onSelect(connectionId: string, directory: string): void;
  onBrowse(connectionId: string, path: string): Promise<RemoteDirectoryListing>;
  onManage(): void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [browsingId, setBrowsingId] = useState("");
  const selected = connections.find((connection) => connection.id === selectedId);
  const browsing = connections.find((connection) => connection.id === browsingId);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) setBrowsingId("");
  }, [open]);

  useEffect(() => {
    if (disabled || locked) setOpen(false);
  }, [disabled, locked]);

  return (
    <div className={`remoteControl ${selected ? "isRemote" : ""} ${open ? "isOpen" : ""}`} ref={rootRef}>
      <button
        className="remoteTrigger"
        type="button"
        disabled={disabled || locked}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          locked
            ? selected
              ? `This chat is running on ${selected.name}`
              : "This chat is running on this computer"
            : selected
              ? `Runs on ${selected.name} in ${directory}`
              : "Runs on this computer"
        }
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? <Server size={14} aria-hidden="true" /> : <Monitor size={14} aria-hidden="true" />}
        <span>{selected ? selected.name : "This computer"}</span>
        {locked ? <Lock size={11} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>

      {open && !browsing ? (
        <div className="remoteMenu" role="menu" aria-label="Where this chat runs">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!selectedId}
            className={!selectedId ? "active" : ""}
            onClick={() => {
              setOpen(false);
              onSelect("", "");
            }}
          >
            <Monitor size={14} aria-hidden="true" />
            <span className="remoteMenuName">This computer</span>
            {!selectedId ? <Check size={14} aria-hidden="true" /> : null}
          </button>

          {connections.length ? <div className="remoteMenuDivider" role="separator" /> : null}

          {connections.map((connection) => {
            const ready = remoteConnectionReady(connection);
            return (
              <button
                key={connection.id}
                type="button"
                role="menuitemradio"
                aria-checked={connection.id === selectedId}
                className={[connection.id === selectedId ? "active" : "", ready ? "" : "isUnready"]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!ready}
                title={ready ? `${connection.username}@${connection.host}` : unreadyReason(connection)}
                onClick={() => {
                  setOpen(false);
                  onSelect(connection.id, connection.defaultDirectory);
                }}
              >
                <Server size={14} aria-hidden="true" />
                <span className="remoteMenuName">{connection.name}</span>
                {connection.id === selectedId ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            );
          })}

          <div className="remoteMenuDivider" role="separator" />

          {selected ? (
            <button type="button" role="menuitem" onClick={() => setBrowsingId(selected.id)}>
              <FolderOpen size={14} aria-hidden="true" />
              <span className="remoteMenuName">Folder: {folderLabel(directory)}</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span className="remoteMenuName">{connections.length ? "Manage remotes…" : "Set up a remote…"}</span>
          </button>
        </div>
      ) : null}

      {open && browsing ? (
        <div className="remoteMenu isBrowsing" role="menu" aria-label={`Folders on ${browsing.name}`}>
          <RemoteFolderBrowser
            title={browsing.name}
            initialPath={browsing.id === selectedId ? directory : browsing.defaultDirectory}
            onBrowse={(path) => onBrowse(browsing.id, path)}
            onBack={() => setBrowsingId("")}
            onChoose={(path) => {
              setOpen(false);
              onSelect(browsing.id, path);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Names the remote host a chat is running on, above its messages. Work that
 * touches another machine's files should say so where the work is read, not
 * only where it was configured.
 */
export function RemoteChatBadge({ name, directory }: { name: string; directory: string }) {
  return (
    <div className="remoteChatBadge" title={`${name}: ${directory}`}>
      <Server size={13} aria-hidden="true" />
      <strong>{name}</strong>
      <span>{directory}</span>
    </div>
  );
}
