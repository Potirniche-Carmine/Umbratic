import type { BackendUiEvent } from "./backendEvents";

/** Generated images have their own conversation cards, outside code review. */
export function withoutGeneratedImages<T extends { path: string }>(files: T[], events: readonly BackendUiEvent[]): T[] {
  const images = new Set(events.flatMap((event) => event.type === "command.finished"
    && event.exitCode === 0 && event.details?.image === true && typeof event.details.path === "string"
    ? [event.details.path.replace(/\\/g, "/")]
    : []));
  return files.filter((file) => !images.has(file.path.replace(/\\/g, "/")));
}
