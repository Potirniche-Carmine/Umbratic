import { useEffect, useState } from "react";
import { ChevronLeft, CornerUpLeft, Folder, Loader2 } from "lucide-react";

import type { RemoteDirectoryListing } from "../shared/desktopApi";

/**
 * Picks a folder on a remote host.
 *
 * Deliberately not a file manager. It walks directories one level at a time and
 * shows nothing else, because the only question it answers is which folder a
 * run should start in. Files are listed by the host but not offered here: they
 * are not a valid answer, and showing them would invite a click that cannot do
 * anything.
 */
export function RemoteFolderBrowser({
  title,
  initialPath,
  onBrowse,
  onChoose,
  onBack,
}: {
  title: string;
  initialPath: string;
  onBrowse(path: string): Promise<RemoteDirectoryListing>;
  onChoose(path: string): void;
  /** Omitted when there is nowhere to go back to. */
  onBack?: () => void;
}) {
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(path: string) {
    setLoading(true);
    setError(null);
    try {
      setListing(await onBrowse(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath);
    // Reloading on every render of the parent would fight the user's navigation;
    // the browser owns its position once it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  const folders = listing?.entries.filter((entry) => entry.kind === "directory") ?? [];

  return (
    <div className="remoteBrowser">
      <div className="remoteBrowserHead">
        {onBack ? (
          <button className="remoteBrowserBack" type="button" onClick={onBack} title="Back">
            <ChevronLeft size={13} aria-hidden="true" />
          </button>
        ) : null}
        <strong title={listing?.path || title}>{listing?.path || title}</strong>
        {loading ? <Loader2 className="spin" size={13} aria-hidden="true" /> : null}
      </div>

      <div className="remoteBrowserList">
        {error ? <div className="remoteBrowserError">{error}</div> : null}
        {listing && listing.path !== "/" ? (
          <button type="button" onClick={() => void load(listing.parentPath)}>
            <CornerUpLeft size={14} aria-hidden="true" />
            <span className="remoteMenuName">Up one folder</span>
          </button>
        ) : null}
        {folders.map((entry) => (
          <button
            key={entry.path}
            type="button"
            disabled={entry.unreadable}
            title={entry.unreadable ? "You cannot open this folder" : entry.path}
            onClick={() => void load(entry.path)}
          >
            <Folder size={14} aria-hidden="true" />
            <span className="remoteMenuName">{entry.name}</span>
          </button>
        ))}
        {listing && !error && folders.length === 0 ? (
          <div className="remoteBrowserEmpty">No folders here</div>
        ) : null}
        {listing?.truncated ? <div className="remoteBrowserEmpty">Only the first folders are listed</div> : null}
      </div>

      <div className="remoteBrowserFoot">
        <button
          className="primaryAction"
          type="button"
          disabled={!listing}
          onClick={() => listing && onChoose(listing.path)}
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
