import { ShieldCheck } from "lucide-react";

/**
 * What is recorded and where it goes. Extracted from the settings dialog
 * unchanged: it is a disclosure document with two buttons, and its wording is
 * easier to review as a document than as one branch of a 6,000-line component.
 */
export function TelemetrySettingsPanel({
  syncEnabled,
  localLogSize,
  busy,
  logEntryCount,
  onExport,
  onClear,
}: {
  /** True when a configured Veil server receives telemetry. */
  syncEnabled: boolean;
  /** Already formatted for display. */
  localLogSize: string;
  busy: boolean;
  logEntryCount: number;
  onExport(): void;
  onClear(): void;
}) {
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Telemetry</h3>
        <p>
          {syncEnabled
            ? "Your organization owns and controls telemetry stored on its configured Veil server."
            : "Your organization owns and controls these logs. In local mode, they remain on this device."}
        </p>
      </div>

      <div className="telemetryPrivacyNotice">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>Umbratic does not collect this data</strong>
          <p>
            Logs and telemetry can be shared with Umbratic only with explicit approval from you or your organization,
            and only to improve the platform.
          </p>
        </div>
      </div>

      <div className="settingsGroup">
        <h4>Local logs</h4>
        <div className="localLogsControl">
          <strong>{localLogSize}</strong>
          <div>
            <button className="settingsInlineButton" type="button" onClick={onExport} disabled={busy}>
              Export
            </button>
            <button
              className="settingsInlineButton"
              type="button"
              onClick={onClear}
              disabled={busy || logEntryCount === 0}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <div className="settingsGroup">
        <h4>{syncEnabled ? "What your server receives" : "Local mode"}</h4>
        <div className="settingsList telemetryDisclosureList">
          {syncEnabled ? (
            <>
              <div className="settingsListRow">
                <span>Activity</span>
                <p>Review opens, editor choices, accept, undo, worktree actions, and context thresholds.</p>
              </div>
              <div className="settingsListRow">
                <span>Rated chats</span>
                <p>Only chats where you rate a response, plus the optional note. Unrated prompt text is not sent.</p>
              </div>
              <div className="settingsListRow">
                <span>Tool failures</span>
                <p>
                  The attempted tool input and returned failure response, so your organization can diagnose problems.
                </p>
              </div>
            </>
          ) : (
            <div className="settingsListRow">
              <span>Uploads</span>
              <p>
                Stored on this device under your organization&apos;s control. Nothing is sent to Umbratic without
                explicit permission.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="settingsGroup">
        <h4>{syncEnabled ? "What stays private" : "What stays local"}</h4>
        <div className="settingsList telemetryDisclosureList">
          <div className="settingsListRow">
            <span>Repository</span>
            <p>
              Source files, repository names and paths, ignored files, diffs, and attachments are never bulk-uploaded.
            </p>
          </div>
          <div className="settingsListRow">
            <span>Sensitive data</span>
            <p>
              Umbratic does not scan environment variables, credentials, keys, secret files, or ignored files for
              telemetry.
            </p>
          </div>
          <div className="settingsListRow">
            <span>Local diagnostics</span>
            <p>SQLite logs, successful tool output, and safe progress updates stay on this computer.</p>
          </div>
        </div>
        {syncEnabled ? (
          <p className="telemetryScopeNote">
            Content included in a rated chat or present in a failed tool request or response is part of that specific
            telemetry item.
          </p>
        ) : null}
      </div>
    </div>
  );
}
