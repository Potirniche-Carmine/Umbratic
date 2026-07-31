export const DEFAULT_CONTEXT_LENGTH = 64_000;
export const CONTEXT_LENGTH_OPTIONS = [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000] as const;

export const CONTEXT_MESSAGE_OVERHEAD_TOKENS = 10;
export const CONTEXT_IMAGE_TOKENS = 1_600;
export const CONTEXT_FILE_TOKENS = 512;
export const CONTEXT_PROTECTED_RESERVE_TOKENS = 2_048;
export const CONTEXT_OUTPUT_RESERVE_TOKENS = 8_192;
export const CONTEXT_MINIMUM_OUTPUT_TOKENS = 1_000;
export const CONTEXT_OUTPUT_STEP_TOKENS = 1_000;

export type ContextAttachment = {
  name?: string;
  path?: string;
  previewDataUrl?: string;
  contextTokens?: number;
};

export type ContextEstimateMessage = {
  text?: string | null;
  attachments?: readonly ContextAttachment[];
};

export type ContextUsageLevel = "normal" | "warning" | "critical";

export type ContextUsageEstimate = {
  contextLength: number;
  contentTokens: number;
  reserveTokens: number;
  protectedTokens: number;
  estimatedTokens: number;
  percentage: number;
  level: ContextUsageLevel;
  overLimit: boolean;
};

export type ContextUsageBase = {
  contentTokens: number;
  reserveTokens?: number;
  protectedTokens?: number;
};

export type ContextMeterVisibilityInput = {
  hasRunnerUsage: boolean;
  timelineItemCount: number;
  prompt: string;
  attachmentCount: number;
};

export function shouldShowContextMeter(input: ContextMeterVisibilityInput): boolean {
  return input.hasRunnerUsage || input.timelineItemCount > 0 || !!input.prompt.trim() || input.attachmentCount > 0;
}

export function normalizeContextLength(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_LENGTH;
  return CONTEXT_LENGTH_OPTIONS.reduce((nearest, option) =>
    Math.abs(option - parsed) < Math.abs(nearest - parsed) ? option : nearest,
  DEFAULT_CONTEXT_LENGTH);
}

export function normalizeEffectiveContextLength(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_LENGTH;
}

export function estimateTextTokens(value: string | undefined | null): number {
  if (!value) return 0;
  let asciiCharacters = 0;
  let nonAsciiBytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) asciiCharacters += 1;
    else if (codePoint <= 0x7ff) nonAsciiBytes += 2;
    else if (codePoint <= 0xffff) nonAsciiBytes += 3;
    else nonAsciiBytes += 4;
  }
  return Math.ceil(asciiCharacters / 4) + Math.ceil(nonAsciiBytes / 2);
}

export function estimateAttachmentTextTokens(value: string): number {
  return estimateTextTokens(value);
}

export function attachmentPromptTokenBudget(contextLength: number): number {
  return Math.max(0, Math.floor(normalizeEffectiveContextLength(contextLength) * 0.5));
}

function prefixWithinTokenBudget(value: string, budget: number): string {
  let asciiCharacters = 0;
  let nonAsciiBytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const nextAscii = asciiCharacters + Number(codePoint <= 0x7f);
    const nextNonAscii = nonAsciiBytes + (codePoint <= 0x7f ? 0 : utf8ByteLength(character));
    if (Math.ceil(nextAscii / 4) + Math.ceil(nextNonAscii / 2) > budget) break;
    asciiCharacters = nextAscii;
    nonAsciiBytes = nextNonAscii;
    end += character.length;
  }
  return value.slice(0, end);
}

function suffixWithinTokenBudget(value: string, budget: number): string {
  let asciiCharacters = 0;
  let nonAsciiBytes = 0;
  let start = value.length;
  while (start > 0) {
    let nextStart = start - 1;
    const trailing = value.charCodeAt(nextStart);
    if (trailing >= 0xdc00 && trailing <= 0xdfff && nextStart > 0) nextStart -= 1;
    const character = value.slice(nextStart, start);
    const codePoint = character.codePointAt(0) ?? 0;
    const nextAscii = asciiCharacters + Number(codePoint <= 0x7f);
    const nextNonAscii = nonAsciiBytes + (codePoint <= 0x7f ? 0 : utf8ByteLength(character));
    if (Math.ceil(nextAscii / 4) + Math.ceil(nextNonAscii / 2) > budget) break;
    asciiCharacters = nextAscii;
    nonAsciiBytes = nextNonAscii;
    start = nextStart;
  }
  return value.slice(start);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function attachmentTextExcerpt(value: string, tokenBudget: number): { text: string; truncated: boolean } {
  const budget = Math.max(0, Math.floor(tokenBudget));
  if (estimateTextTokens(value) <= budget) return { text: value, truncated: false };
  if (budget === 0) return { text: "", truncated: true };
  const marker = "\n\n...[middle omitted from initial context; complete attachment remains available]...\n\n";
  const markerTokens = estimateTextTokens(marker);
  if (budget <= markerTokens) return { text: prefixWithinTokenBudget(value, budget), truncated: true };
  const contentBudget = budget - markerTokens;
  const head = prefixWithinTokenBudget(value, Math.ceil(contentBudget / 2));
  const tail = suffixWithinTokenBudget(value.slice(head.length), Math.floor(contentBudget / 2));
  return { text: `${head}${marker}${tail}`, truncated: true };
}

export function isImageContextAttachment(attachment: ContextAttachment): boolean {
  if (attachment.previewDataUrl?.startsWith("data:image/")) return true;
  const candidate = `${attachment.name ?? ""} ${attachment.path ?? ""}`.toLowerCase();
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:\s|$)/i.test(candidate);
}

export function adaptiveOutputReserve(contextLength: number, contentTokens: number): number {
  const preferred = Math.min(CONTEXT_OUTPUT_RESERVE_TOKENS, Math.floor(contextLength * 0.5));
  const available = Math.max(0, contextLength - contentTokens);
  if (available >= preferred) return preferred;
  if (available < CONTEXT_MINIMUM_OUTPUT_TOKENS) return Math.min(preferred, CONTEXT_MINIMUM_OUTPUT_TOKENS);
  return Math.min(preferred, Math.floor(available / CONTEXT_OUTPUT_STEP_TOKENS) * CONTEXT_OUTPUT_STEP_TOKENS);
}

export function estimateContextUsage(
  messages: readonly ContextEstimateMessage[],
  configuredContextLength: unknown,
  base?: ContextUsageBase,
): ContextUsageEstimate {
  const contextLength = normalizeEffectiveContextLength(configuredContextLength);
  let contentTokens = Number.isFinite(base?.contentTokens) ? Math.max(0, Math.round(base?.contentTokens ?? 0)) : 0;
  const protectedTokens = Number.isFinite(base?.protectedTokens)
    ? Math.max(0, Math.round(base?.protectedTokens ?? 0))
    : !base
      ? Math.min(CONTEXT_PROTECTED_RESERVE_TOKENS, Math.floor(contextLength * 0.25))
      : 0;
  if (!base) {
    contentTokens += protectedTokens;
  }
  let remainingAttachmentTokens = attachmentPromptTokenBudget(contextLength);
  for (const message of messages) {
    const attachments = message.attachments ?? [];
    const attachmentTokens = attachments.reduce(
      (total, attachment) => {
        if (isImageContextAttachment(attachment)) return total + CONTEXT_IMAGE_TOKENS;
        const measured = attachment.contextTokens;
        const requested = Number.isFinite(measured) && (measured ?? -1) >= 0 ? Math.round(measured ?? 0) : CONTEXT_FILE_TOKENS;
        const included = Math.min(requested, remainingAttachmentTokens);
        remainingAttachmentTokens -= included;
        return total + included;
      },
      0,
    );
    if (!message.text && attachmentTokens === 0) continue;
    contentTokens += CONTEXT_MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.text) + attachmentTokens;
  }

  const reserveTokens = Number.isFinite(base?.reserveTokens)
    ? Math.max(0, Math.round(base?.reserveTokens ?? 0))
    : adaptiveOutputReserve(contextLength, contentTokens);
  const estimatedTokens = contentTokens + reserveTokens;
  const percentage = (estimatedTokens / contextLength) * 100;
  const level: ContextUsageLevel = percentage >= 90 ? "critical" : percentage >= 75 ? "warning" : "normal";
  return {
    contextLength,
    contentTokens,
    reserveTokens,
    protectedTokens,
    estimatedTokens,
    percentage,
    level,
    overLimit: estimatedTokens > contextLength,
  };
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${Math.max(0, Math.round(tokens))}`;
  const thousands = tokens / 1_000;
  return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}K`;
}
