import { CloudPermissionSettings } from "./CloudPermissionSettings";
import type { CloudApi } from "../../shared/cloud";
import React, { useState } from "react";
import { CloudProviderAccount } from "./CloudProviderAccount";
import { cloudRoleLabels, type CloudProvider, type CloudRole, type CloudSettings } from "../../shared/cloud";
import { CloudModelPicker } from "./CloudModelPicker";
import { cloudProviderIcons } from "./CloudProviderIcon";
import { CloudSelect } from "./CloudSelect";
import type { CloudConnectionController } from "./useCloudConnection";

/** Subscription settings inside the same dialog as local models, Veil, and workspace tools. */
export function CloudSettingsPanel({ api, settings, controllers, busy, onSave }: {
  api: CloudApi; settings: CloudSettings; controllers: Record<CloudProvider, CloudConnectionController>; busy: boolean;
  onSave(value: CloudSettings): Promise<void>;
}) {
  const [tab, setTab] = useState<"accounts" | "experts" | "context" | "permissions" | "browser">("accounts");
  const [provider, setProvider] = useState<CloudProvider>(settings.provider);
  const [browserInstalling, setBrowserInstalling] = useState(false);
  const [browserMessage, setBrowserMessage] = useState("");
  async function installBrowser() {
    setBrowserInstalling(true); setError(""); setBrowserMessage("");
    try { await api.installCloudBrowser(); setBrowserMessage("Browser installed. You can enable browser verification now."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBrowserInstalling(false); }
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { connection } = controllers[provider];
  const installing = Object.values(controllers).some(controller => ["install", "disconnect"].includes(controller.working));
  const config = settings.providers[provider];
  const models = connection?.provider === provider ? connection.models : [];
  const locked = saving || installing;
  async function save(next: CloudSettings) {
    setSaving(true); setError("");
    try { await onSave(next); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <div className="settingsPanel providerSettings">
    <div className="settingsPanelHead"><h3>Providers</h3></div>
    <div className="providerSettingsTabs" role="group" aria-label="Provider settings">
      {(["accounts", "experts", "context", "permissions", "browser"] as const).map(id => <button key={id} aria-pressed={id === tab} onClick={() => setTab(id)}>{id === "accounts" ? "Accounts" : id === "experts" ? "Experts" : id === "context" ? "Context" : id === "permissions" ? "Permissions" : "Browser"}</button>)}
    </div>
    {tab === "accounts" && <>{(["codex", "claude"] as const).map(id => <CloudProviderAccount key={id} provider={id} controller={controllers[id]} disabled={busy || locked}/>)}</>}
    {tab === "experts" && <>
      <div className="cloudSettingGroup">
        <div className="cloudSettingRow"><span>Use experts</span><button type="button" role="switch" aria-label="Use experts" aria-checked={settings.subagents}
          className={`toggle ${settings.subagents ? "isOn" : ""}`} disabled={locked} onClick={() => void save({ ...settings, subagents: !settings.subagents })}><span className="toggleKnob"/></button></div>
        <div className="cloudSettingRow"><span>Provider presets</span><CloudSelect label="Expert provider presets" icons={cloudProviderIcons} value={provider} disabled={locked} onValueChange={value => setProvider(value as CloudProvider)}><option value="codex">ChatGPT</option><option value="claude">Claude</option></CloudSelect></div>
      </div>
      <div className="cloudExpertList">{(Object.keys(cloudRoleLabels) as CloudRole[]).map(role => <CloudModelPicker key={role} label={cloudRoleLabels[role]} value={config.roles[role]} models={models}
        disabled={locked || !settings.subagents} onChange={choice => void save({ ...settings, providers: { ...settings.providers, [provider]: { ...config, roles: { ...config.roles, [role]: choice } } } })}/>)}</div>
    </>}
    {tab === "context" && <>
      <div className="cloudSettingGroup"><div className="cloudSettingRow"><span>Fresh context after</span><CloudSelect label="Reset after a break" disabled={locked} value={settings.idleResetHours} onValueChange={value => void save({ ...settings, idleResetHours: Number(value) })}>
        <option value={0}>Never</option>{Array.from({ length: 24 }, (_, index) => index + 1).map(hours => <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
      </CloudSelect></div></div>
    </>}
    {tab === "permissions" && <CloudPermissionSettings api={api}/>}
    {tab === "browser" && <div className="cloudSettingGroup"><div className="cloudSettingRow"><span>Browser verification</span><button type="button" role="switch" aria-label="Browser verification" aria-checked={!!settings.browserVerification} className={`toggle ${settings.browserVerification ? "isOn" : ""}`} disabled={locked} onClick={() => void save({ ...settings, browserVerification: !settings.browserVerification })}><span className="toggleKnob"/></button></div><p>Give ChatGPT and Claude a separate browser to navigate, interact, capture screenshots, and inspect console errors. Screenshots stay in the chat workspace.</p><p>Requires Node.js/npm. Install the browser once; first use also downloads Microsoft’s Playwright MCP (0.0.84). Your personal browser profile is not used. Applies to the next turn.</p><button disabled={browserInstalling} onClick={() => void installBrowser()}>{browserInstalling ? "Installing browser…" : "Install browser"}</button>{browserMessage && <p role="status">{browserMessage}</p>}</div>}
    {error && <p className="cloudSettingsMessage" role="alert">{error}</p>}
  </div>;
}
