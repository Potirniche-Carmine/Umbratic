import React, { useEffect, useState } from "react";
import type { CloudApi, CloudAllowedCommand } from "../../shared/cloud";
import { CloudProviderIcon } from "./CloudProviderIcon";

export function CloudPermissionSettings({ api }: { api: CloudApi }) {
  const [rules, setRules] = useState<CloudAllowedCommand[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  useEffect(() => { let active = true; void api.listCloudAllowedCommands().then(value => { if (active) setRules(value); }).catch(cause => { if (active) setError(String(cause)); }); return () => { active = false; }; }, [api]);
  async function revoke(id: string) {
    setPending(id); setError("");
    try { await api.revokeCloudAllowedCommand({ id }); setRules(await api.listCloudAllowedCommands()); }
    catch (cause) { setError(String(cause)); } finally { setPending(undefined); }
  }
  return <div className="cloudSettingGroup cloudPermissionSettings">
    <h4>Always allowed commands</h4>
    <p className="cloudPermissionHint">Remembered for this provider and workspace.</p>
    {!rules.length && <p>No saved commands. Choose Always allow on a command approval to remember it.</p>}
    {rules.map(rule => <div className="cloudCommandRule" key={rule.id}>
      <div className="cloudCommandRuleHeader"><span><CloudProviderIcon provider={rule.provider}/><strong>{rule.provider === "codex" ? "ChatGPT" : "Claude"}</strong></span><button type="button" disabled={!!pending} onClick={() => void revoke(rule.id)} aria-label={`Revoke ${rule.command}`}>{pending === rule.id ? "Revoking…" : "Revoke"}</button></div>
      <pre>{rule.command}</pre><small title={rule.cwd}>{rule.cwd}</small>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
