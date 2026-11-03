import { KeyboardSettingsPanel } from "../KeyboardSettings";
import { ShortcutTooltip } from "../Tooltip";
import { shortcutForEvent } from "../keyboardShortcuts";
import { VoiceSettings } from "../VoiceSettings";
import type { DesktopApi, BackendStatus } from "../../shared/desktopApi";
import { CloudUsageDetails } from "./CloudUsage";
import React, { useEffect, useRef, useState } from "react";
import { Check, Keyboard, Mic, Monitor, RefreshCw, RotateCcw, Users, X } from "lucide-react";
import { cloudRoleLabels, type CloudProvider, type CloudRole, type CloudSettings, type CloudUsage } from "../../shared/cloud";
import { readAppearanceSettings, writeAppearanceSettings } from "../appearanceStorage";
import type { AppearanceTheme } from "../rendererTypes";
import { CloudModelPicker } from "./CloudModelPicker";
import { CloudProviderIcon, cloudProviderIcons } from "./CloudProviderIcon";
import { CloudSelect } from "./CloudSelect";
import type { useCloudConnection } from "./useCloudConnection";

type ConnectionController = ReturnType<typeof useCloudConnection>;
export function CloudSettingsPanel({ api, initialTab = "connection", sendOnEnter = true, settings, controller, usage, onSave, onClose }: {
  api: DesktopApi; initialTab?: "connection" | "voice" | "keyboard"; sendOnEnter?: boolean; usage?: CloudUsage; settings: CloudSettings; controller: ConnectionController;
  onSave(value: CloudSettings): Promise<void>; onClose(): void;
}) {
  const [tab, setTab] = useState<"connection" | "experts" | "context" | "voice" | "keyboard">(initialTab);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  useEffect(() => { void api.getBackendStatus().then(setBackend); }, [api]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(() => readAppearanceSettings().theme);
  const dialog = useRef<HTMLDialogElement>(null);
  const { connection, checking, working, message, refresh, connect, install, cancel } = controller;
  const provider = settings.provider;
  const name = provider === "codex" ? "Codex" : "Claude Code";
  const config = settings.providers[provider];
  const models = connection?.provider === provider ? connection.models : [];
  const locked = saving || working === "install";
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
  }} onClick={event => { if (event.target !== event.currentTarget || locked) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); }} onCancel={event => { event.preventDefault(); if (!saving && working !== "install") onClose(); }}>
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
          <div className="cloudSettingGroup">
            <div className="cloudSettingRow"><span>Provider</span><CloudSelect label="Cloud provider" icons={cloudProviderIcons} value={provider} disabled={locked} onValueChange={selectedValue => void save({ ...settings, provider: selectedValue as CloudProvider })}><option value="codex">ChatGPT</option><option value="claude">Claude Code</option></CloudSelect></div>
            <div className="cloudAccountRow">
              <div className="cloudProviderMark"><CloudProviderIcon provider={provider}/></div>
              <div className="cloudAccountIdentity"><strong>{provider === "codex" ? "ChatGPT" : "Claude"}</strong><span>{working === "connect" ? "Waiting for sign-in…" : checking ? "Checking connection…" : connection?.state === "ready" ? connection.accountEmail || "Connected" : connection?.state === "missing" ? `${name} not installed` : "Not connected"}</span></div>
              {connection?.state === "ready" && connection.planName && <span className="cloudPlanBadge">{connection.planName}</span>}
              {connection?.state === "ready" ? <Check className="cloudConnected" size={17} aria-label="Connected"/> : <button className="cloudPrimary cloudAction" disabled={locked || checking && working !== "connect"} onClick={() => void (working === "connect" ? cancel() : connection?.state === "missing" ? install() : connect())}>
                {working === "install" ? "Installing…" : working === "connect" ? "Cancel" : connection?.state === "missing" ? `Install ${name}` : `Connect ${name}`}
              </button>}
              <button className="cloudIconButton" disabled={locked || checking} aria-label="Refresh connection" onClick={() => void refresh()}><RefreshCw size={15}/></button>
            </div>
          </div>
          <CloudModelPicker label="Main orchestrator" value={config.orchestrator} models={models} disabled={locked} onChange={orchestrator => updateProvider({ orchestrator, serviceTier: models.find(model => model.id === orchestrator.model)?.serviceTiers?.some(tier => tier.id === config.serviceTier) ? config.serviceTier : "default" })}/>
          {connection?.state === "ready" && <CloudUsageDetails usage={usage}/>}
        </>}
        {tab === "experts" && <>
          <div className="cloudSettingGroup">
            {toggle("Use experts", settings.subagents, subagents => void save({ ...settings, subagents }))}
          </div>
          <div className="cloudExpertList">{(Object.keys(cloudRoleLabels) as CloudRole[]).map(role => <CloudModelPicker key={role} label={cloudRoleLabels[role]} value={config.roles[role]} models={models}
            disabled={locked || !settings.subagents}
            onChange={choice => updateProvider({ roles: { ...config.roles, [role]: choice } })}/>)}</div>
        </>}
        {tab === "context" && <>
          <div className="cloudSettingGroup">
            <div className="cloudSettingRow"><span>Reset after a break</span><CloudSelect label="Reset after a break" disabled={locked} value={settings.idleResetHours} onValueChange={selectedValue => void save({ ...settings, idleResetHours: Number(selectedValue) })}>
              <option value={0}>Never</option>{Array.from({ length: 24 }, (_, index) => index + 1).map(hours => <option key={hours} value={hours}>{hours} {hours === 1 ? "hour" : "hours"}</option>)}
            </CloudSelect></div>

          </div>

        </>}
        {tab === "keyboard" && <KeyboardSettingsPanel api={api} mode="cloud" showHeading={false} sendOnEnter={sendOnEnter}/>}
        {tab === "voice" && <VoiceSettings showHeading={false} api={api} backend={backend} active onBackendStatus={setBackend} serverMode={false} speechAdvertised={false}/>}
        {(error || message || connection?.state === "unsupported_account" || connection?.state === "unavailable") && <p className="cloudSettingsMessage" role={error ? "alert" : "status"}>{error || message || connection?.message}</p>}
      </section>

    </div>
  </dialog>;
}
