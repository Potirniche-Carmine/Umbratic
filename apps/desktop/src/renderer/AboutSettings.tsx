import { useEffect, useState, type ReactElement } from "react";
import { AlertCircle, Check, RefreshCw, RotateCw } from "lucide-react";
import type { AppUpdateStatus, DesktopApi } from "../shared/desktopApi";

/**
 * Which build this is, and whether a newer one exists.
 *
 * The status comes from the main process, which owns the updater; this pane
 * only shows it and forwards two decisions — check now, and whether to keep
 * checking on its own. Progress arrives on its own channel, so a download that
 * finishes while the pane is open turns the button into "Restart to update"
 * without anyone asking again.
 */
export function AboutSettingsPanel({ api }: { api: DesktopApi }) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

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

  // What the button says once a check comes back, held for a moment and then
  // let go. The row's own text stays put: the answer to "check now" is given
  // where the question was asked, and nothing else on the page moves for it.
  const [result, setResult] = useState<"current" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 2200);
    return () => window.clearTimeout(timer);
  }, [result]);

  // A check against a nearby feed answers in milliseconds, which reads as the
  // button flickering rather than as anything having happened. The busy state
  // is held for a beat so the spinner is seen and the answer arrives settled.
  async function checkNow() {
    setChecking(true);
    try {
      const [next] = await Promise.all([api.checkForAppUpdate(), new Promise((resolve) => setTimeout(resolve, 900))]);
      setStatus(next);
      if (next.state.phase === "current") setResult("current");
      else if (next.state.phase === "failed") setResult("failed");
    } finally {
      setChecking(false);
    }
  }

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
  const busy = checking || state?.phase === "checking";
  const label = checkLabel(state, busy, result);

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
          ) : (
            <button
              className="settingsInlineButton aboutCheck"
              type="button"
              aria-busy={busy || undefined}
              onClick={() => void checkNow()}
              disabled={state?.phase === "unsupported" || state?.phase === "downloading"}
            >
              {label.icon}
              <span>{label.text}</span>
            </button>
          )}
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
 * The button's face. It is the one thing on the row that moves: idle it asks,
 * busy it spins, and for a moment after a check it answers — then it asks
 * again. A click during the answer starts another check; nothing is disabled
 * for the sake of the animation.
 */
function checkLabel(
  state: AppUpdateStatus["state"] | undefined,
  busy: boolean,
  result: "current" | "failed" | null,
): { text: string; icon: ReactElement } {
  if (state?.phase === "downloading") {
    return { text: `Downloading ${state.percent}%`, icon: <RefreshCw size={13} className="aboutSpin" /> };
  }
  if (busy) return { text: "Checking", icon: <RefreshCw size={13} className="aboutSpin" /> };
  if (result === "current") return { text: "Up to date", icon: <Check size={13} /> };
  if (result === "failed") return { text: "Couldn't check", icon: <AlertCircle size={13} /> };
  return { text: "Check now", icon: <RefreshCw size={13} /> };
}

/**
 * The one line under the name. It says when the feed was last consulted and
 * otherwise holds still: the outcome of a check is answered on the button,
 * and a line that rewrote itself with every answer would pull the eye for
 * nothing. The exceptions are the states that ask something of the user.
 */
function describe(status: AppUpdateStatus): string {
  const { state } = status;
  switch (state.phase) {
    case "unsupported":
      return "Development build";
    case "ready":
      return `${state.latestVersion} is downloaded and installs when you restart`;
    case "downloading":
      return `${state.latestVersion} is available`;
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
