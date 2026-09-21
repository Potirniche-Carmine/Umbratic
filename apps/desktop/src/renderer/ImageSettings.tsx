import { useEffect, useState } from "react";
import type { DesktopApi } from "../shared/desktopApi";
import { LocalModelFolder, LocalModelMenu, useLocalModelCatalog } from "./LocalModelList";

export function ImageSettings({ api, serverMode }: { api: DesktopApi; serverMode: boolean }) {
  const catalog = useLocalModelCatalog(api, "image", !serverMode);
  const [settings, setSettings] = useState({ model: "off", runtimeAvailable: true });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void api.getImageSettings().then(setSettings).catch(() => setMessage("Image settings could not be loaded.")); }, [api]);
  async function select(model: string) {
    setSaving(true);
    setMessage(null);
    try { setSettings(await api.saveImageSettings({ model })); }
    catch { setMessage("The image model could not be changed."); }
    finally { setSaving(false); }
  }
  async function download(id: string) {
    await catalog.download(id);
    const rows = await api.listLocalModels({ kind: "image" });
    if (rows.some((row) => row.id === id && row.downloaded)) await select(id);
  }
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead"><h3>Image</h3></div>
      <div className="settingsGroup">
        {serverMode ? <p className="settingsMessage">Your server manages the image model.</p> : <>
          <LocalModelMenu label="Image model" models={catalog.models} progress={catalog.progress} selectedId={settings.model}
            disabled={saving || !settings.runtimeAvailable} placeholder="Choose a model" leadingOption={{ id: "off", label: "Off" }}
            onSelect={(id) => void select(id)} onDownload={(id) => void download(id)} onCancel={(id) => void catalog.cancel(id)}
            onQuantChange={(id, quant) => void catalog.setQuant(id, quant)} />
          <p className="settingsMessage">Loaded only when you create an image.</p>
          {!settings.runtimeAvailable ? <p className="settingsMessage" role="alert">Image generation is unavailable in this build.</p> : null}
          <LocalModelFolder api={api} />
        </>}
        <div className="connectionFeedback" aria-live="polite">
          {message || catalog.message ? <p className="settingsMessage" role="alert">{message || catalog.message}</p> : null}
        </div>
      </div>
      <div className="settingsGroup">
        <p className="settingsMessage">Use <strong>@image</strong> or ask your chat model to create an image.</p>
      </div>
    </div>
  );
}
