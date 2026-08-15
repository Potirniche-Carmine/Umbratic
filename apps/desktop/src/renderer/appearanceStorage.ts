import type { WorkspaceMode } from "../shared/desktopApi";
import type { AppearanceSettings, AppearanceTheme } from "./rendererTypes";

const appearanceSettingsKey = "umbratic-ui-appearance";
const workspaceModeKey = "umbratic-ui-workspace-mode";

export const defaultAppearanceSettings: AppearanceSettings = {
  theme: "system",
  uiFont: "System UI",
  monoFont: "System UI",
};

export const defaultUiFontChoices = [
  "System UI",
  "Segoe UI",
  "SF Pro Text",
  "Inter",
  "Arial",
  "Roboto",
  "Helvetica Neue",
  "Verdana",
];

export const defaultMonoFontChoices = [
  "System UI",
  "Cascadia Code",
  "SF Mono",
  "Consolas",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "ui-monospace",
];

export type LocalFontDescriptor = {
  family?: string;
  fullName?: string;
};

type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontDescriptor[]>;
};

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === "system" || value === "light" || value === "dark";
}

export function readAppearanceSettings(): AppearanceSettings {
  try {
    const settings = JSON.parse(window.localStorage.getItem(appearanceSettingsKey) ?? "{}") as Partial<AppearanceSettings>;
    return {
      theme: isAppearanceTheme(settings.theme) ? settings.theme : defaultAppearanceSettings.theme,
      uiFont: typeof settings.uiFont === "string" && settings.uiFont.trim() ? settings.uiFont : defaultAppearanceSettings.uiFont,
      monoFont: typeof settings.monoFont === "string" && settings.monoFont.trim() ? settings.monoFont : defaultAppearanceSettings.monoFont,
    };
  } catch {
    return defaultAppearanceSettings;
  }
}

export function writeAppearanceSettings(settings: AppearanceSettings) {
  window.localStorage.setItem(appearanceSettingsKey, JSON.stringify(settings));
}

export function readWorkspaceMode(): WorkspaceMode {
  return window.localStorage.getItem(workspaceModeKey) === "worktree" ? "worktree" : "local";
}

export function writeWorkspaceMode(mode: WorkspaceMode) {
  window.localStorage.setItem(workspaceModeKey, mode);
}

export function uniqueFonts(fonts: string[]): string[] {
  return Array.from(new Set(fonts.map((font) => font.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export function cssFontValue(font: string, fallback: string): string {
  if (font === "System UI") return `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  if (/^(system-ui|ui-monospace|serif|sans-serif|monospace)$/i.test(font)) return `${font}, ${fallback}`;
  return `"${font.replace(/"/g, "")}", ${fallback}`;
}

export function localFontAccessAvailable(): boolean {
  return typeof (window as LocalFontWindow).queryLocalFonts === "function";
}

export async function listLocalFontFamilies(): Promise<string[] | null> {
  const queryLocalFonts = (window as LocalFontWindow).queryLocalFonts;
  if (!queryLocalFonts) return null;
  const fonts = await queryLocalFonts();
  return uniqueFonts(fonts.map((font) => font.family || font.fullName || ""));
}

