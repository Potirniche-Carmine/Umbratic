import { BarChart3, Brain, Info, Keyboard, Mic, Server, Settings2, Sparkles, Type, User } from "lucide-react";

/** The sections of the settings dialog, in the order they are shown. */
export type SettingsTab = "general" | "account" | "remote" | "harness" | "appearance" | "voice" | "keyboard" | "skills" | "telemetry" | "about";

const sections: Array<{ id: SettingsTab; label: string; icon: typeof User }> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "account", label: "Connection", icon: User },
  { id: "remote", label: "Remote", icon: Server },
  { id: "harness", label: "Harness", icon: Brain },
  { id: "appearance", label: "Appearance", icon: Type },
  { id: "voice", label: "Voice", icon: Mic },
  // Beside Voice, which is where the one chord it documents comes from.
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "telemetry", label: "Telemetry", icon: BarChart3 },
  { id: "about", label: "About", icon: Info },
];

export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsTab;
  onSelect(tab: SettingsTab): void;
}) {
  return (
    <nav className="settingsNav" aria-label="Settings sections">
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className={`settingsNavItem ${active === section.id ? "isActive" : ""}`}
          aria-current={active === section.id ? "page" : undefined}
          onClick={() => onSelect(section.id)}
        >
          <section.icon size={15} />
          <span>{section.label}</span>
        </button>
      ))}
    </nav>
  );
}
