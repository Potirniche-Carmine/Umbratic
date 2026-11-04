import React, { useCallback, useEffect, useState } from "react";
import type { DesktopApi } from "../../shared/desktopApi";
import { defaultCloudSettings, type CloudSettings } from "../../shared/cloud";
import { cssFontValue, readAppearanceSettings } from "../appearanceStorage";
import { WorkspaceNavigation, type WorkspaceActivity, type WorkspaceProvider, type LocalWorkspaceSurfaceProps } from "../WorkspaceNavigation";
import { useCloudConnection } from "./useCloudConnection";
import { CloudSettingsPanel } from "./CloudSettingsPanel";
import type { SettingsTab } from "../SettingsNav";
import { WorkspaceSidebarResize } from "../WorkspaceChrome";
import { CloudWorkspace } from "./CloudWorkspace";

const selectionKey = "umbratic.workspace-provider";
function initialProvider(settings: CloudSettings): WorkspaceProvider {
  try {
    const saved = localStorage.getItem(selectionKey);
    if (saved === "local" || saved === "codex" || saved === "claude") return saved;
  } catch { /* Storage can be unavailable in a restricted window. */ }
  return settings.mode === "private" ? "local" : settings.provider;
}

export function WorkspaceRoot({ api, renderPrivate }: { api: DesktopApi; renderPrivate(props: LocalWorkspaceSurfaceProps): React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(246);
  useEffect(() => {
    const resize = () => setSidebarWidth(width => Math.min(width, Math.max(196, Math.min(300, Math.round(window.innerWidth * .34)))));
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [provider, setProvider] = useState<WorkspaceProvider>("local");
  const [visited, setVisited] = useState<Set<WorkspaceProvider>>(new Set());
  const [activity, setActivity] = useState<Record<WorkspaceProvider, WorkspaceActivity>>({ local: "idle", codex: "idle", claude: "idle" });
  const [settingsRequest, setSettingsRequest] = useState<{ id: number; tab: SettingsTab } | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const codex = useCloudConnection(api, "codex", settings?.providers.codex.executable || "");
  const claude = useCloudConnection(api, "claude", settings?.providers.claude.executable || "");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.getCloudSettings().catch(cause => { setError(String(cause)); return defaultCloudSettings(); }).then(value => {
      if (!current) return;
      const selected = initialProvider(value); setSettings(value); setProvider(selected); setVisited(new Set([selected]));
    });
    return () => { current = false; };
  }, [api]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const appearance = readAppearanceSettings();
      const theme = appearance.theme === "system" ? media.matches ? "dark" : "light" : appearance.theme;
      document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
      document.documentElement.style.setProperty("--app-font", cssFontValue(appearance.uiFont, "system-ui, sans-serif"));
      document.documentElement.style.setProperty("--mono-font", cssFontValue(appearance.monoFont, "ui-monospace, monospace"));
      void api.setWindowChromeTheme(theme);
    };
    apply(); media.addEventListener("change", apply); window.addEventListener("umbratic:appearance-change", apply);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("umbratic:appearance-change", apply); };
  }, [api]);
  const reportActivity = useCallback((id: WorkspaceProvider, state: WorkspaceActivity) => {
    setActivity(current => current[id] === state ? current : { ...current, [id]: state });
  }, []);
  function select(id: WorkspaceProvider) {
    setProvider(id); setVisited(current => new Set([...current, id]));
    try { localStorage.setItem(selectionKey, id); } catch { /* Selection still works in memory. */ }
  }
  async function save(next: CloudSettings) { setSettings(await api.saveCloudSettings(next)); }
  if (!settings) return <div className="cloudLoading" role="status">Opening your workspace…</div>;
  const controllers = { codex, claude };
  const providerSettings = <CloudSettingsPanel settings={settings} controllers={controllers} busy={activity.codex !== "idle" || activity.claude !== "idle"} onSave={save}/>;
  const openSettings = (tab: SettingsTab) => setSettingsRequest(current => ({ id: (current?.id || 0) + 1, tab }));
  const navigation = <><WorkspaceNavigation provider={provider} activity={activity} onSelect={select}/><WorkspaceSidebarResize width={sidebarWidth} onChange={setSidebarWidth}/></>;
  return <div className="unifiedWorkspace" style={{ "--sidebar-width": `${sidebarWidth}px`, "--sidebar-reserved-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <div className="workspaceSurface" hidden={provider !== "local"} inert={provider !== "local"}>
      {renderPrivate({ active: provider === "local", navigation, onActivity: state => reportActivity("local", state), settingsRequest, providerSettings, onSettingsVisibility: setSettingsVisible })}
    </div>
    {(["codex", "claude"] as const).filter(id => visited.has(id)).map(id => <div key={id} className="workspaceSurface" hidden={provider !== id} inert={provider !== id}>
      <CloudWorkspace api={api} settings={{ ...settings, provider: id }} onSettings={save} controllers={controllers} settingsVisible={settingsVisible} cloudBusy={activity.codex !== "idle" || activity.claude !== "idle"} onOpenSettings={openSettings} active={provider === id} navigation={navigation} onActivity={state => reportActivity(id, state)}/>
    </div>)}
    {error && <div className="cloudRootError" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
  </div>;
}
