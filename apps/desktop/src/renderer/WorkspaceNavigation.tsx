import React from "react";
import type { SettingsTab } from "./SettingsNav";
import { Monitor } from "lucide-react";
import { cloudProviderIcons } from "./cloud/CloudProviderIcon";

export type WorkspaceProvider = "local" | "codex" | "claude";
export type WorkspaceActivity = "idle" | "running" | "waiting";
export const workspaceProviderLabels: Record<WorkspaceProvider, string> = { local: "Local & Veil", codex: "ChatGPT", claude: "Claude" };
export type WorkspaceSurfaceProps = { active: boolean; navigation: React.ReactNode; onActivity(state: WorkspaceActivity): void };

export type LocalWorkspaceSurfaceProps = WorkspaceSurfaceProps & {
  settingsRequest: { id: number; tab: SettingsTab } | null;
  providerSettings: React.ReactNode;
  onSettingsVisibility(visible: boolean): void;
};

export function WorkspaceNavigation({ provider, activity, onSelect }: {
  provider: WorkspaceProvider; activity: Record<WorkspaceProvider, WorkspaceActivity>; onSelect(provider: WorkspaceProvider): void;
}) {
  return <div className="workspaceNavigation">
    <div className="workspaceIdentity"><span className="topbarLogo" aria-hidden="true"/><span>Umbratic</span></div>
    <nav aria-label="Chat providers" className="workspaceProviders">
      {(["codex", "claude", "local"] as const).map(id => <button type="button" key={id}
        className={`workspaceProvider ${provider === id ? "isSelected" : ""}`} aria-current={provider === id ? "page" : undefined} onClick={() => onSelect(id)}>
        <span className="workspaceProviderIcon">{id === "local" ? <Monitor size={17}/> : cloudProviderIcons[id]}</span>
        <span>{workspaceProviderLabels[id]}</span>
        {activity[id] !== "idle" && <span className={`workspaceActivity is-${activity[id]}`} role="status" aria-label={`${workspaceProviderLabels[id]} ${activity[id] === "waiting" ? "needs your attention" : "is working"}`}/>}
      </button>)}
    </nav>
    <p className="workspaceProviderNote">{provider === "local" ? "Local models and your Veil server" : `Your ${workspaceProviderLabels[provider]} conversations`}</p>
  </div>;
}
