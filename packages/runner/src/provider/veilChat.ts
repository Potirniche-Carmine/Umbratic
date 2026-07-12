import { isApprovedVeilChatUrl } from "./local.js";

export function isVeilChatEndpoint(url: string): boolean {
  return isApprovedVeilChatUrl(url);
}
