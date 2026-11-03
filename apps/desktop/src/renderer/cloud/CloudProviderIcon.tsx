import React from "react";
import type { CloudProvider } from "../../shared/cloud";
import chatgpt from "./assets/chatgpt.svg?url";
import claude from "./assets/claude.svg?url";

// Vendor artwork is kept verbatim; these marks identify connected services.
export function CloudProviderIcon({ provider }: { provider: CloudProvider }) {
  return <img className="cloudProviderIcon" src={provider === "codex" ? chatgpt : claude} alt="" aria-hidden="true"/>;
}
export const cloudProviderIcons = { codex: <CloudProviderIcon provider="codex"/>, claude: <CloudProviderIcon provider="claude"/> };
