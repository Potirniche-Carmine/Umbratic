import type { UmbraticRunnerEvent } from "../events.js";

type AssistantStreamEvent = Extract<
  UmbraticRunnerEvent,
  { type: "assistant.delta" | "assistant.reasoning.delta" }
>;

const announcementStarters = ["let me", "i'll", "i will", "i need to", "i should"];
const workspaceToolVerbs = [
  "read", "inspect", "check", "search", "open", "list", "look at", "review",
  "run", "test", "verify", "edit", "write", "create", "update", "fetch", "grab",
];
const announcementPhrases = announcementStarters.flatMap((starter) =>
  workspaceToolVerbs.map((verb) => `${starter} ${verb}`),
);

function normalizedPrefix(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:first|next|now)[,:-]?\s+/, "");
}

export function createProviderStreamEmitter(
  emit: ((event: UmbraticRunnerEvent) => void) | undefined,
  options: { suppressContent: boolean; guardToolAnnouncements: boolean },
): { emit(event: UmbraticRunnerEvent): void; flush(): void } {
  let state: "pending" | "streaming" | "blocked" = options.guardToolAnnouncements ? "pending" : "streaming";
  let answerStarted = false;
  let prefix = "";
  let buffered: Array<Extract<AssistantStreamEvent, { type: "assistant.delta" }>> = [];

  const startAnswer = (event: Extract<AssistantStreamEvent, { type: "assistant.delta" }>) => {
    if (answerStarted) return;
    answerStarted = true;
    emit?.({ type: "assistant.answer.started", taskId: event.taskId, at: event.at });
  };

  const flushBuffered = () => {
    if (buffered[0]) startAnswer(buffered[0]);
    for (const event of buffered) emit?.(event);
    buffered = [];
  };

  return {
    emit(event) {
      if (event.type !== "assistant.delta" && event.type !== "assistant.reasoning.delta") {
        emit?.(event);
        return;
      }
      if (event.type === "assistant.reasoning.delta") {
        emit?.(event);
        return;
      }
      if (options.suppressContent || state === "blocked") return;
      if (state === "streaming") {
        startAnswer(event);
        emit?.(event);
        return;
      }

      buffered.push(event);
      prefix += event.text;
      const normalized = normalizedPrefix(prefix);
      if (announcementPhrases.some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `) || normalized.startsWith(`${phrase}:`))) {
        state = "blocked";
        buffered = [];
        return;
      }
      if (!normalized || announcementPhrases.some((phrase) => phrase.startsWith(normalized))) return;

      state = "streaming";
      flushBuffered();
    },
    flush() {
      if (state === "pending") flushBuffered();
    },
  };
}
