import { useEffect, useState } from "react";

import type { BackendStatus, DesktopApi, DictationSettings } from "../shared/desktopApi";
import { Combobox } from "./Combobox";
import { DictationModelList, LocalModelFolder, useLocalModelCatalog } from "./LocalModelList";

/**
 * Dictation settings.
 *
 * Local mode owns a model here and downloads it like any other. Server mode
 * owns nothing: the company server either offers transcription or it does not,
 * and this panel says which rather than offering a choice that would not apply.
 */

const languages: Array<{ id: string; label: string }> = [
  { id: "", label: "Auto" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "ro", label: "Romanian" },
  { id: "zh", label: "Chinese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
];

export function VoiceSettings({
  api,
  backend,
  active,
  serverMode,
  speechAdvertised,
  onBackendStatus,
}: {
  api: DesktopApi;
  backend: BackendStatus | null;
  active: boolean;
  serverMode: boolean;
  speechAdvertised: boolean;
  onBackendStatus: (status: BackendStatus) => void;
}) {
  const [dictation, setDictation] = useState<DictationSettings>({ model: "off", language: null, deviceId: null });
  const [message, setMessage] = useState<string | null>(null);
  const catalog = useLocalModelCatalog(api, "dictation", active && !serverMode);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void api.getDictationSettings().then((settings) => {
      if (current) setDictation(settings);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [active, api]);

  async function save(next: DictationSettings) {
    // Re-picking what is already picked is not a change, and saving it anyway
    // restarts the speech runtime — so a click meant to read a row would drop
    // the weights behind it.
    if (next.model === dictation.model && next.language === dictation.language) return;
    const previous = dictation;
    setDictation(next);
    setMessage(null);
    try {
      const result = await api.saveDictationSettings(next);
      setDictation(result.dictation);
      onBackendStatus(result.status);
    } catch (cause) {
      setDictation(previous);
      setMessage(String(cause instanceof Error ? cause.message : cause));
    }
  }

  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Voice</h3>
      </div>

      <div className="settingsGroup">
        {serverMode ? (
          <p className="settingsMessage">
            {speechAdvertised
              ? "Dictation is provided by your company server."
              : "Your company server does not offer dictation."}
          </p>
        ) : (
          <>
            <DictationModelList
              models={catalog.models}
              progress={catalog.progress}
              selectedId={dictation.model}
              disabled={false}
              onSelect={(id) => void save({ ...dictation, model: id as DictationSettings["model"] })}
              onDownload={(id) => void catalog.download(id)}
              onCancel={(id) => void catalog.cancel(id)}
            />
            {catalog.message ? <p className="settingsMessage">{catalog.message}</p> : null}
            <LocalModelFolder api={api} />
            {/* "auto" stands in for the stored null: the dropdown cannot carry
                an empty id, and dictation stores automatic detection as null. */}
            <Combobox
              label="Language"
              items={languages.map((language) => ({ id: language.id || "auto", label: language.label }))}
              selectedId={dictation.language ?? "auto"}
              onSelect={(id) => void save({ ...dictation, language: id === "auto" ? null : id })}
            />
          </>
        )}
        {/* One place for anything that went wrong, with its height reserved so a
            message arriving does not move the controls underneath it. The old
            download notice lived here too and flashed on every pick: the status
            it read from is a round trip behind the choice, so it announced a
            problem that had already stopped being true. */}
        <div className="connectionFeedback" aria-live="polite">
          {message ? <p className="settingsMessage">{message}</p> : null}
        </div>
      </div>
    </div>
  );
}
