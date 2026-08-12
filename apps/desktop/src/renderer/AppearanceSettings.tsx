import type { ReactNode } from "react";
import { Loader2, Monitor, Moon, RefreshCw, Sun } from "lucide-react";

/**
 * Theme and typography. Extracted from the settings dialog unchanged: it reads
 * four values and calls two functions, so keeping its markup inside the app
 * component bought nothing.
 */

export type AppearanceTheme = "system" | "light" | "dark";

export type AppearancePreferences = {
  theme: AppearanceTheme;
  uiFont: string;
  monoFont: string;
};

const themeOptions: Array<{ id: AppearanceTheme; label: string; icon: ReactNode }> = [
  { id: "system", label: "System", icon: <Monitor size={15} /> },
  { id: "light", label: "Light", icon: <Sun size={15} /> },
  { id: "dark", label: "Dark", icon: <Moon size={15} /> },
];

export function AppearanceSettingsPanel({
  settings,
  uiFontOptions,
  monoFontOptions,
  fontScanPending,
  fontScanMessage,
  fontScanAvailable,
  onChange,
  onScanFonts,
}: {
  settings: AppearancePreferences;
  uiFontOptions: string[];
  monoFontOptions: string[];
  fontScanPending: boolean;
  fontScanMessage: string | null;
  /** False where the browser has no local font access to offer. */
  fontScanAvailable: boolean;
  onChange(next: Partial<AppearancePreferences>): void;
  onScanFonts(): void;
}) {
  return (
    <div className="settingsPanel">
      <div className="settingsPanelHead">
        <h3>Appearance</h3>
        <p>Theme and typography used throughout Umbratic.</p>
      </div>

      <div className="settingsGroup">
        <h4>Theme</h4>
        <div className="appearanceOptionGrid">
          {themeOptions.map((option) => (
            <button
              className={settings.theme === option.id ? "isActive" : ""}
              key={option.id}
              type="button"
              aria-pressed={settings.theme === option.id}
              onClick={() => onChange({ theme: option.id })}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settingsGroup">
        <h4>Fonts</h4>
        <label className="settingsField">
          <span>Interface</span>
          <select value={settings.uiFont} onChange={(event) => onChange({ uiFont: event.target.value })}>
            {uiFontOptions.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>
        <label className="settingsField">
          <span>Code</span>
          <select value={settings.monoFont} onChange={(event) => onChange({ monoFont: event.target.value })}>
            {monoFontOptions.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>
        <div className="settingsActions">
          <button
            className="settingsInlineButton"
            type="button"
            onClick={onScanFonts}
            disabled={fontScanPending || !fontScanAvailable}
            title={fontScanAvailable ? "Scan installed fonts" : "System font scanning is unavailable here"}
          >
            {fontScanPending ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
            <span>Scan system fonts</span>
          </button>
          {!fontScanAvailable ? (
            <p className="settingsMessage">
              System font scanning is unavailable here, so Umbratic is showing common system font choices.
            </p>
          ) : null}
          {fontScanMessage ? <p className="settingsMessage">{fontScanMessage}</p> : null}
        </div>
      </div>

      <div className="appearancePreview">
        <strong>Preview</strong>
        <p>The quick brown fox jumps over a careful build log.</p>
        <code>cmake --build .umbratic/build --parallel</code>
      </div>
    </div>
  );
}
