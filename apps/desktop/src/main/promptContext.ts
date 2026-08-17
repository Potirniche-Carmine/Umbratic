export type ContextPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data_url: string };

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** The user's local calendar day, for factual context — not a clock or timezone lecture. */
export function localCalendarDate(date: Date = new Date()): string {
  return `${weekdayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function localDateContextLine(date: Date = new Date()): string {
  return `today's date: ${localCalendarDate(date)}`;
}

export function shouldIncludeWorkspaceContext(input: {
  hasProject: boolean;
  workspaceHasFiles: boolean;
  attachmentCount: number;
  historicalAttachmentCount: number;
}): boolean {
  return input.hasProject
    || input.workspaceHasFiles
    || input.attachmentCount > 0
    || input.historicalAttachmentCount > 0;
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
