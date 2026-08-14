import { BarChart3, Brain, Mic, Server, Sparkles, Type, User } from "lucide-react";

/** The sections of the settings dialog, in the order they are shown. */
export type SettingsTab = "account" | "remote" | "harness" | "appearance" | "voice" | "skills" | "telemetry";

const sections: Array<{ id: SettingsTab; label: string; icon: typeof User }> = [
  { id: "account", label: "Connection", icon: User },
  { id: "remote", label: "Remote", icon: Server },
  { id: "harness", label: "Harness", icon: Brain },
  { id: "appearance", label: "Appearance", icon: Type },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "telemetry", label: "Telemetry", icon: BarChart3 },
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
