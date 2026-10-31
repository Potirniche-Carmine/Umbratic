import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { AppUpdateStatus, DesktopApi } from "../shared/desktopApi";

/**
 * Which build this is, and whether a newer one exists.
 *
 * The status comes from the main process, which owns the updater; this pane
 * shows it and forwards one decision — whether to keep checking on its own.
 * There is nothing here that asks the feed on demand: the app looks shortly
 * after launch and every few hours it stays open, which is the whole of it.
 * A button would only have let someone re-ask a question already being asked,
 * and on an installation the feed will not serve it would have been an invitation
 * to keep pressing it. Progress arrives on its own channel, so a download that
 * finishes while the pane is open turns the row into "Restart to update"
 * without anyone asking again.
 */
export function AboutSettingsPanel({ api }: { api: DesktopApi }) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getAppUpdateStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    const stop = api.onAppUpdateStatus((next) => setStatus(next));
    return () => {
      cancelled = true;
      stop();
    };
  }, [api]);

  async function setAutomatic(enabled: boolean) {
    setStatus(await api.setAutomaticAppUpdates({ enabled }));
  }

  // "Checked 3 min ago" has to keep being true while the pane stays open.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const state = status?.state;

  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>About</h3>
      </div>

      <div className="settingsGroup">
        <div className="aboutRow">
          <div className="aboutRowText">
            <strong>
              Umbratic
              {status ? <em className="aboutVersion">{status.installedVersion}</em> : null}
            </strong>
            <span>{status ? describe(status) : ""}</span>
          </div>
          {state?.phase === "ready" ? (
            <button className="settingsInlineButton" type="button" onClick={() => void api.installAppUpdate()}>
              <RotateCw size={13} />
              <span>Restart to update</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="settingsGroup">
        <div className="aboutRow">
          <div className="aboutRowText">
            <strong>Check for updates automatically</strong>
          </div>
          <button
            type="button"
            className={`toggle ${status?.automatic ? "isOn" : ""}`}
            role="switch"
            aria-checked={!!status?.automatic}
            aria-label="Check for updates automatically"
            disabled={!status || state?.phase === "unsupported"}
            onClick={() => void setAutomatic(!status?.automatic)}
          >
            <span className="toggleKnob" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The one line under the name, and now the only thing that reports: with no
 * button to answer on, an outcome that does not appear here does not appear
 * at all. It still holds as still as it can — a version and a time for the
 * ordinary case, and plain language for the rest.
 */
function describe(status: AppUpdateStatus): string {
  const { state } = status;
  switch (state.phase) {
    case "unsupported":
      return "Development build";
    case "checking":
      return "Checking for updates";
    case "ready":
      return `${state.latestVersion} is downloaded and installs when you restart`;
    case "downloading":
      return `Downloading ${state.latestVersion} — ${state.percent}%`;
    case "failed":
      return `${state.message} — ${checkedAgo(status.checkedAt).toLowerCase()}`;
    default:
      return checkedAgo(status.checkedAt);
  }
}

function checkedAgo(checkedAt: string | null): string {
  if (!checkedAt) return "Not checked yet";
  const minutes = Math.round((Date.now() - new Date(checkedAt).getTime()) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `Checked ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}
