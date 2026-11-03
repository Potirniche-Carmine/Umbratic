import { KeyboardSettingsPanel } from "../KeyboardSettings";
import { ShortcutTooltip } from "../Tooltip";
import { shortcutForEvent } from "../keyboardShortcuts";
import { VoiceSettings } from "../VoiceSettings";
import type { DesktopApi, BackendStatus } from "../../shared/desktopApi";
import { CloudProviderAccount } from "./CloudProviderAccount";
import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Mic, Monitor, RotateCcw, Users, X } from "lucide-react";
import { cloudRoleLabels, type CloudProvider, type CloudRole, type CloudSettings, type CloudUsage } from "../../shared/cloud";
import { readAppearanceSettings, writeAppearanceSettings } from "../appearanceStorage";
import type { AppearanceTheme } from "../rendererTypes";
import { CloudModelPicker } from "./CloudModelPicker";
import { cloudProviderIcons } from "./CloudProviderIcon";
import { CloudSelect } from "./CloudSelect";
import type { CloudConnectionController } from "./useCloudConnection";

export function CloudSettingsPanel({ api, initialTab = "connection", sendOnEnter = true, settings, controllers, usage, onSave, onClose }: {
  api: DesktopApi; initialTab?: "connection" | "voice" | "keyboard"; sendOnEnter?: boolean; usage?: CloudUsage; settings: CloudSettings; controllers: Record<CloudProvider, CloudConnectionController>;
  onSave(value: CloudSettings): Promise<void>; onClose(): void;
}) {
  const [tab, setTab] = useState<"connection" | "experts" | "context" | "voice" | "keyboard">(initialTab);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  useEffect(() => { void api.getBackendStatus().then(setBackend); }, [api]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(() => readAppearanceSettings().theme);
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<CloudProvider>(settings.provider);
  const { connection } = controllers[provider];
  const installing = Object.values(controllers).some(controller => ["install", "disconnect"].includes(controller.working));
  const config = settings.providers[provider];
  const models = connection?.provider === provider ? connection.models : [];
  const locked = saving || installing;
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus(); return () => element?.close(); }, []);
  async function save(next: CloudSettings) {
    setSaving(true); setError("");
    try { await onSave(next); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  function updateProvider(patch: Partial<typeof config>) {
    void save({ ...settings, providers: { ...settings.providers, [provider]: { ...config, ...patch } } });
  }
  function toggle(label: string, checked: boolean, change: (value: boolean) => void, disabled = false) {
    return <div className="cloudSettingRow"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={checked}
      className={`toggle ${checked ? "isOn" : ""}`} disabled={locked || disabled} onClick={() => change(!checked)}><span className="toggleKnob"/></button></div>;
  }
  return <dialog className="cloudSettings" ref={dialog} aria-labelledby="cloud-settings-title" onKeyDown={event => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return;
    const shortcut = shortcutForEvent(event.nativeEvent);
    if (shortcut?.id === "app.settings" || shortcut?.id === "app.shortcuts") {
      event.preventDefault(); event.stopPropagation();
      if (shortcut.id === "app.shortcuts") setTab("keyboard"); else if (!locked) onClose();
    }
  }} onClick={event => { if (event.target !== event.currentTarget || locked) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); }} onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
    <div className="cloudSettingsSidebar">
      <div className="cloudSettingsTitle"><h2 id="cloud-settings-title">Settings</h2></div>
      <nav aria-label="Cloud settings sections">
        <button aria-current={tab === "connection" ? "page" : undefined} onClick={() => setTab("connection")}><Monitor size={17}/> General</button>
        <button aria-current={tab === "experts" ? "page" : undefined} onClick={() => setTab("experts")}><Users size={17}/> Experts</button>
        <button aria-current={tab === "context" ? "page" : undefined} onClick={() => setTab("context")}><RotateCcw size={17}/> Context</button>
        <button aria-current={tab === "voice" ? "page" : undefined} onClick={() => setTab("voice")}><Mic size={17}/> Voice</button>
        <ShortcutTooltip id="app.shortcuts"><button aria-current={tab === "keyboard" ? "page" : undefined} onClick={() => setTab("keyboard")}><Keyboard size={17}/> Keyboard</button></ShortcutTooltip>
      </nav>
    </div>
    <div className="cloudSettingsMain">
      <header><h3>{tab === "connection" ? "General" : tab === "experts" ? "Experts" : tab === "voice" ? "Voice" : tab === "keyboard" ? "Keyboard" : "Context"}</h3><ShortcutTooltip id="dialog.dismiss" label="Close settings"><button className="cloudIconButton" aria-label="Close settings" disabled={locked} onClick={onClose}><X size={18}/></button></ShortcutTooltip></header>
      <section className="cloudSettingsContent">
        {tab === "connection" && <>
          <div className="cloudSettingGroup">
            <div className="cloudSettingRow"><span>Mode</span><CloudSelect label="Mode" value={settings.mode} disabled={locked} onValueChange={selectedValue => void save({ ...settings, mode: selectedValue as "cloud" | "private" })}><option value="cloud">Cloud</option><option value="private">Private</option></CloudSelect></div>
            <div className="cloudSettingRow"><span>Appearance</span><CloudSelect label="Appearance" value={theme} onValueChange={selectedValue => { const value = selectedValue as AppearanceTheme; setTheme(value); writeAppearanceSettings({ ...readAppearanceSettings(), theme: value }); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></CloudSelect></div>
          </div>
          <h4 className="cloudSettingsSectionLabel">Connected accounts</h4>
          {(["codex", "claude"] as const).map(id => <CloudProviderAccount key={id} provider={id} controller={controllers[id]} disabled={locked} usage={id === settings.provider ? usage : undefined}/>)}
        </>}
        {tab === "experts" && <>
          <div className="cloudSettingGroup">
            {toggle("Use experts", settings.subagents, subagents => void save({ ...settings, subagents }))}
            <div className="cloudSettingRow"><span>Provider presets</span><CloudSelect label="Expert provider presets" icons={cloudProviderIcons} value={provider} disabled={locked} onValueChange={value => setProvider(value as CloudProvider)}><option value="codex">ChatGPT</option><option value="claude">Claude Code</option></CloudSelect></div>
          </div>
          <div className="cloudExpertList">{(Object.keys(cloudRoleLabels) as CloudRole[]).map(role => <CloudModelPicker key={role} label={cloudRoleLabels[role]} value={config.roles[role]} models={models}
            disabled={locked || !settings.subagents}
            onChange={choice => updateProvider({ roles: { ...config.roles, [role]: choice } })}/>)}</div>
        </>}
        {tab === "context" && <>
          <p className="cloudSettingsIntro">Choose how long to keep a conversation between work sessions.</p>
          <div className="cloudSettingGroup">
            <div className="cloudSettingRow"><span>Reset after a break</span><CloudSelect label="Reset after a break" disabled={locked} value={settings.idleResetHours} onValueChange={selectedValue => void save({ ...settings, idleResetHours: Number(selectedValue) })}>
              <option value={0}>Never</option>{Array.from({ length: 24 }, (_, index) => index + 1).map(hours => <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
            </CloudSelect></div>

          </div>
        </>}
        {tab === "keyboard" && <KeyboardSettingsPanel api={api} mode="cloud" showHeading={false} sendOnEnter={sendOnEnter}/>}
        {tab === "voice" && <VoiceSettings showHeading={false} api={api} backend={backend} active onBackendStatus={setBackend} serverMode={false} speechAdvertised={false}/>}
        {error && <p className="cloudSettingsMessage" role="alert">{error}</p>}
      </section>

    </div>
  </dialog>;
}
