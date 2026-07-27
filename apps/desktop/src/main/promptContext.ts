export type ContextPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data_url: string };

export function isCasualConversationPrompt(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:hi|hello|hey|hey there|good morning|good afternoon|good evening)(?: (?:tell me about yourself|who are you|how are you|what can you do))?$/.test(
    normalized,
  );
}

export function shouldIncludeWorkspaceContext(
  prompt: string,
  attachmentCount: number,
): boolean {
  return attachmentCount > 0 || !isCasualConversationPrompt(prompt);
}

export function limitPromptImages(
  parts: readonly ContextPromptPart[],
  maxImages: number,
  maxImageCharacters = Number.POSITIVE_INFINITY,
): ContextPromptPart[] {
  const limit = Math.max(0, Math.floor(maxImages));
  const characterLimit = Math.max(0, Math.floor(maxImageCharacters));
  let keptImages = 0;
  let keptImageCharacters = 0;
  let omittedImages = 0;
  const kept: ContextPromptPart[] = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type === "image") {
      if (keptImages >= limit || keptImageCharacters + part.data_url.length > characterLimit) {
        omittedImages += 1;
        continue;
      }
      keptImages += 1;
      keptImageCharacters += part.data_url.length;
    }
    kept.unshift(part);
  }
  if (omittedImages > 0) {
    kept.unshift({
      type: "text",
      text: `${omittedImages} older image attachment${omittedImages === 1 ? " was" : "s were"} omitted to keep the model request within its image limit.`,
    });
  }
  return kept;
}
