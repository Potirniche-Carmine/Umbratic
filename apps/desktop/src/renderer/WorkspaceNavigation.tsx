import React from "react";
import type { SettingsTab } from "./SettingsNav";
import { Monitor } from "lucide-react";
import { cloudProviderIcons } from "./cloud/CloudProviderIcon";
import { ChatActivityIndicator, type WorkspaceActivity } from "./ChatActivityIndicator";
export type { WorkspaceActivity } from "./ChatActivityIndicator";

export type WorkspaceProvider = "local" | "codex" | "claude";
export const workspaceProviderLabels: Record<WorkspaceProvider, string> = { local: "Local & Veil", codex: "ChatGPT", claude: "Claude" };
export type WorkspaceSurfaceProps = { active: boolean; navigation: React.ReactNode; onActivity(state: WorkspaceActivity, unread?: boolean): void };

export type LocalWorkspaceSurfaceProps = WorkspaceSurfaceProps & {
  settingsRequest: { id: number; tab: SettingsTab } | null;
  providerSettings: React.ReactNode;
  onSettingsVisibility(visible: boolean): void;
};

export function WorkspaceNavigation({ provider, activity, unread, onSelect }: {
  provider: WorkspaceProvider; activity: Record<WorkspaceProvider, WorkspaceActivity>; unread?: Partial<Record<WorkspaceProvider, boolean>>; onSelect(provider: WorkspaceProvider): void;
}) {
  return <div className="workspaceNavigation">
    <div className="workspaceIdentity"><span className="topbarLogo" aria-hidden="true"/><span>Umbratic</span></div>
    <nav aria-label="Chat providers" className="workspaceProviders">
      {(["codex", "claude", "local"] as const).map(id => <button type="button" key={id}
        className={`workspaceProvider ${provider === id ? "isSelected" : ""}`} aria-label={workspaceProviderLabels[id]} aria-current={provider === id ? "page" : undefined} onClick={() => onSelect(id)}>
        <span className="workspaceProviderIcon">{id === "local" ? <Monitor size={17}/> : cloudProviderIcons[id]}</span>
        <span>{workspaceProviderLabels[id]}</span>
        <ChatActivityIndicator state={activity[id]} unread={unread?.[id]} label={`${workspaceProviderLabels[id]} ${activity[id] === "waiting" ? "needs your attention" : activity[id] === "running" ? "is working" : "has unread replies"}`}/>
      </button>)}
    </nav>
  </div>;
}
