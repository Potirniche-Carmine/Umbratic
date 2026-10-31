import { ShieldCheck } from "lucide-react";

export function DiagnosticsSettingsPanel({
  localLogSize,
  busy,
  logEntryCount,
  onExport,
  onClear,
}: {
  localLogSize: string;
  busy: boolean;
  logEntryCount: number;
  onExport(): void;
  onClear(): void;
}) {
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead"><h3>Privacy &amp; logs</h3></div>
      <div className="telemetryPrivacyNotice">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>No telemetry</strong>
          <p>Umbratic does not collect product analytics or upload diagnostic logs.</p>
        </div>
      </div>
      <div className="settingsGroup">
        <div className="localLogsControl">
          <div className="localLogsLabel"><strong>Local logs</strong><span>{localLogSize}</span></div>
          <div>
            <button className="settingsInlineButton" type="button" onClick={onExport} disabled={busy}>Export</button>
            <button className="settingsInlineButton" type="button" onClick={onClear} disabled={busy || logEntryCount === 0}>Clear</button>
          </div>
        </div>
      </div>
      <div className="settingsGroup">
        <div className="settingsList telemetryDisclosureList">
          <div className="settingsListRow"><span>Model requests</span><p>Your messages and task context go to the model connection you choose. Your server operator controls its data handling.</p></div>
          <div className="settingsListRow"><span>Diagnostics</span><p>Redacted error logs stay on this device. Export creates a local file you can choose to share.</p></div>
        </div>
      </div>
    </div>
  );
}
