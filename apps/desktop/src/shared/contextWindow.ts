export const DEFAULT_CONTEXT_LENGTH = 64_000;
export const CONTEXT_LENGTH_OPTIONS = [4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000] as const;

export const CONTEXT_MESSAGE_OVERHEAD_TOKENS = 10;
export const CONTEXT_IMAGE_TOKENS = 1_600;
export const CONTEXT_FILE_TOKENS = 512;
export const CONTEXT_PROTECTED_RESERVE_TOKENS = 4_096;
export const CONTEXT_OUTPUT_RESERVE_TOKENS = 4_096;

export type ContextAttachment = {
  name?: string;
  path?: string;
  previewDataUrl?: string;
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
  estimatedTokens: number;
  percentage: number;
  level: ContextUsageLevel;
  overLimit: boolean;
};

export type ContextUsageBase = {
  contentTokens: number;
  reserveTokens?: number;
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
  return value ? Math.ceil(value.length / 4) : 0;
}

export function isImageContextAttachment(attachment: ContextAttachment): boolean {
  if (attachment.previewDataUrl?.startsWith("data:image/")) return true;
  const candidate = `${attachment.name ?? ""} ${attachment.path ?? ""}`.toLowerCase();
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:\s|$)/i.test(candidate);
}

export function estimateContextUsage(
  messages: readonly ContextEstimateMessage[],
  configuredContextLength: unknown,
  base?: ContextUsageBase,
): ContextUsageEstimate {
  const contextLength = normalizeEffectiveContextLength(configuredContextLength);
  let contentTokens = Number.isFinite(base?.contentTokens) ? Math.max(0, Math.round(base?.contentTokens ?? 0)) : 0;
  for (const message of messages) {
    const attachments = message.attachments ?? [];
    const attachmentTokens = attachments.reduce(
      (total, attachment) => total + (isImageContextAttachment(attachment) ? CONTEXT_IMAGE_TOKENS : CONTEXT_FILE_TOKENS),
      0,
    );
    if (!message.text && attachmentTokens === 0) continue;
    contentTokens += CONTEXT_MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.text) + attachmentTokens;
  }

  const outputReserve = Math.min(CONTEXT_OUTPUT_RESERVE_TOKENS, Math.floor(contextLength * 0.25));
  const protectedReserve = Math.min(CONTEXT_PROTECTED_RESERVE_TOKENS, Math.floor(contextLength * 0.25));
  const defaultReserveTokens = outputReserve + protectedReserve;
  const reserveTokens = Number.isFinite(base?.reserveTokens)
    ? Math.max(0, Math.round(base?.reserveTokens ?? 0))
    : defaultReserveTokens;
  const estimatedTokens = contentTokens + reserveTokens;
  const percentage = (estimatedTokens / contextLength) * 100;
  const level: ContextUsageLevel = percentage >= 90 ? "critical" : percentage >= 75 ? "warning" : "normal";
  return {
    contextLength,
    contentTokens,
    reserveTokens,
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
