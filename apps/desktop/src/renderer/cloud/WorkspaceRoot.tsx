import React, { useEffect, useState } from "react";
import type { DesktopApi } from "../../shared/desktopApi";
import { defaultCloudSettings, type CloudSettings } from "../../shared/cloud";
import { cssFontValue, readAppearanceSettings } from "../appearanceStorage";
import { CloudWorkspace } from "./CloudWorkspace";

export function WorkspaceRoot({ api, renderPrivate }: { api: DesktopApi; renderPrivate(onCloud: () => void): React.ReactNode }) {
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.getCloudSettings().then(setSettings).catch(cause => { setSettings(defaultCloudSettings()); setError(String(cause)); }); }, [api]);
  useEffect(() => {
    if (settings?.mode !== "cloud") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const appearance = readAppearanceSettings();
      const theme = appearance.theme === "system" ? media.matches ? "dark" : "light" : appearance.theme;
      document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
      document.documentElement.style.setProperty("--app-font", cssFontValue(appearance.uiFont, "system-ui, sans-serif"));
      void api.setWindowChromeTheme(theme);
    };
    apply(); media.addEventListener("change", apply); window.addEventListener("umbratic:appearance-change", apply);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("umbratic:appearance-change", apply); };
  }, [settings?.mode, api]);
  async function save(next: CloudSettings) { const value = await api.saveCloudSettings(next); setSettings(value); }
  function switchMode() { if (settings) void save({ ...settings, mode: settings.mode === "private" ? "cloud" : "private" }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }
  if (!settings) return <div className="cloudLoading" role="status">Opening your workspace…</div>;
  return <>{settings.mode === "private" ? renderPrivate(switchMode) : <CloudWorkspace api={api} settings={settings} onSettings={save}/>}
    {error && <div className="cloudRootError" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}</>;
}
