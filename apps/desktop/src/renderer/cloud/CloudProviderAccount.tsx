import React from "react";
import { LogOut, RefreshCw } from "lucide-react";
import type { CloudProvider, CloudUsage } from "../../shared/cloud";
import { CloudProviderIcon } from "./CloudProviderIcon";
import { CloudUsageDetails } from "./CloudUsage";
import type { CloudConnectionController } from "./useCloudConnection";

export function CloudProviderAccount({ provider, controller, usage, disabled }: {
  provider: CloudProvider; controller: CloudConnectionController; usage?: CloudUsage; disabled: boolean;
}) {
  const { connection, working, checking, message, connect, cancel, install, refresh, disconnect } = controller;
  const name = provider === "codex" ? "ChatGPT" : "Claude Code";
  const connected = connection?.state === "ready";
  const detail = working === "connect" ? "Waiting for sign-in…" : checking ? "Checking connection…"
    : connected ? connection.accountEmail : connection?.state === "missing" ? "Not installed" : "Not connected";
  return <div className="cloudSettingGroup cloudProviderAccount">
    <div className="cloudAccountRow">
      <div className="cloudProviderMark"><CloudProviderIcon provider={provider}/>{connected && <span className="cloudConnectionDot" role="img" aria-label="Connected" title="Connected"/>}</div>
      <div className="cloudAccountIdentity"><div className="cloudAccountHeading"><strong>{name}</strong>{connected && connection.planName && <span className="cloudPlanBadge">{connection.planName}</span>}</div>{detail && <span>{detail}</span>}</div>
      <div className="cloudAccountActions">
      <button type="button" className="cloudIconButton" disabled={disabled || checking || !!working} aria-label={`Refresh ${name} connection and usage`} title={`Refresh ${name}`} onClick={() => void refresh()}><RefreshCw size={16} strokeWidth={1.8} aria-hidden="true"/></button>
      {connected ? <button type="button" className="cloudAccountDisconnect" disabled={disabled || checking || !!working} aria-label={`Disconnect ${name}`} onClick={() => void disconnect()}><LogOut size={14} strokeWidth={1.8} aria-hidden="true"/><span>{working === "disconnect" ? "Disconnecting…" : "Disconnect"}</span></button> : <button type="button" className="cloudPrimary cloudAction" disabled={disabled || checking && working !== "connect"} onClick={() => void (working === "connect" ? cancel() : connection?.state === "missing" ? install() : connect())}>
        {working === "install" ? "Installing…" : working === "connect" ? "Cancel" : connection?.state === "missing" ? "Install" : "Connect"}
      </button>}
      </div>
    </div>
    {connection?.state === "ready" && <CloudUsageDetails usage={usage || connection.usage}/>}
    {(message || connection?.state === "unsupported_account" || connection?.state === "unavailable") && <p className="cloudSettingsMessage" role="status">{message || connection?.message}</p>}
  </div>;
}
