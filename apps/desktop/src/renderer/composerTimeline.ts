import { progressKind } from "../shared/backendEvents";
import type { BackendUiEvent, ChatAttachment, TaskState } from "../shared/desktopApi";
import { activityHasNarration, activityHasTools, thoughtDurationMs } from "./activityTiming";
import { normalizeAttachment } from "./chatListPresentation";
import type { CommandRun } from "./commandDisplay";
import type { ComposerActivitySegment, ComposerTimelineItem } from "./rendererTypes";
import { visibleReviewPrompt } from "./review/reviewComments";

// Assistant text renders as the model wrote it. Stripping a "Umbratic:" prefix
// was a word list: every phrasing it lacked leaked anyway, and it ate the first
// words of an answer that legitimately opened on the name.
export function composerTimelineFromEvents(
  events: BackendUiEvent[],
  taskPrompt?: string,
  taskState?: TaskState,
): ComposerTimelineItem[] {
  const runs = new Map<string, CommandRun>();
  const items: ComposerTimelineItem[] = [];
  let assistantBuffer = "";
  let assistantNeedsSeparator = false;
  let assistantIndex = 0;
  let activitySegments: ComposerActivitySegment[] = [];
  let activityStartedAt: string | undefined;
  let activityEndedAt: string | undefined;
  let activityIndex = 0;
  const commandSegmentIds = new Set<string>();
  let reasoningBuffer = "";
  let reasoningStartedAt: string | undefined;
  let reasoningEndedAt: string | undefined;
  let reasoningKind: "thinking" | undefined;
  let reasoningIndex = 0;
  let skillIndex = 0;
  let compactionIndex = 0;
  const prompt = taskPrompt?.trim();
  const hasUserMessages = events.some((event) => event.type === "user.message");

  if (prompt && !hasUserMessages) {
    const visiblePrompt = visibleReviewPrompt(prompt);
    items.push({ type: "user", id: "user-prompt", text: visiblePrompt.text, rawText: prompt, reviewFeedback: visiblePrompt.feedback, attachedFiles: [] });
  }

  // Assistant prose is the answer only once nothing follows it. The runner
  // streams it as `assistant.delta` while it is generated. Guided tool-calling
  // steps omit accompanying prose, so orientation and the tool rows are the
  // mid-run story. After tools, a live burst is held inside Working until the
  // turn ends — it might still be a mid-round report.
  const flushAssistant = (streaming = false) => {
    const text = assistantBuffer.trim();
    if (!text) { assistantBuffer = ""; assistantNeedsSeparator = false; return; }
    assistantIndex += 1;
    items.push({
      type: "assistant",
      id: `assistant-${assistantIndex}`,
      text,
      streaming: streaming || undefined,
    });
    assistantBuffer = ""; assistantNeedsSeparator = false;
  };

  const markActivityTime = (startedAt?: string, endedAt?: string) => {
    if (startedAt && !activityStartedAt) {
      activityStartedAt = startedAt;
    }
    const end = endedAt ?? startedAt;
    if (end) {
      activityEndedAt = end;
    }
  };

  const activeCommandSegment = (id: string) =>
    activitySegments.some((segment) => segment.type === "command" && segment.run.id === id);

  const ensureCommandSegment = (run: CommandRun) => {
    if (!commandSegmentIds.has(run.id)) {
      commandSegmentIds.add(run.id);
      activitySegments.push({ type: "command", id: run.id, run });
      return true;
    }
    return activeCommandSegment(run.id);
  };

  const flushActivity = (finished = true) => {
    if (!activitySegments.length) {
      if (activityStartedAt && !finished) {
        activityIndex += 1;
        items.push({
          type: "activity",
          id: `activity-${activityIndex}`,
          segments: [],
          startedAt: activityStartedAt,
          endedAt: activityEndedAt,
          finished: false,
        });
      }
      activityStartedAt = undefined;
      activityEndedAt = undefined;
      return;
    }
    // Keep a finished block that holds narration so live thinking can collapse
    // rather than vanish when the answer starts.
    if (finished && !activityHasTools(activitySegments) && !activityHasNarration(activitySegments)) {
      activitySegments = [];
      activityStartedAt = undefined;
      activityEndedAt = undefined;
      return;
    }
    activityIndex += 1;
    items.push({
      type: "activity",
      id: `activity-${activityIndex}`,
      segments: activitySegments,
      startedAt: activityStartedAt,
      endedAt: activityEndedAt,
      finished,
    });
    activitySegments = [];
    activityStartedAt = undefined;
    activityEndedAt = undefined;
  };

  const flushReasoning = (finished = true, held = false) => {
    const text = reasoningBuffer.trim();
    const kind = reasoningKind;
    const startedAt = reasoningStartedAt;
    const endedAt = reasoningEndedAt;
    const redundantCompletion = /^(?:#{1,6}\s*)?work(?:\s+is)?\s+complete(?:d)?[.!:]*$/i.test(text);
    reasoningBuffer = "";
    reasoningStartedAt = undefined;
    reasoningEndedAt = undefined;
    reasoningKind = undefined;
    if (!text || redundantCompletion) return;
    reasoningIndex += 1;
    markActivityTime(startedAt, endedAt);
    activitySegments.push({
      type: "reasoning",
      id: `reasoning-${reasoningIndex}`,
      text,
      durationMs: thoughtDurationMs(startedAt, endedAt, finished),
      finished,
      ...(kind ? { kind } : {}),
      ...(held ? { held: true } : {}),
    });
  };

  // Prose the run wrote before its next piece of work joins the narration
  // inside the block. Thinking is a different register, so a live thinking
  // passage is closed first rather than concatenated into the sentence.
  const foldProseIntoNarration = () => {
    if (!assistantBuffer.trim()) return;
    if (reasoningKind === "thinking" && reasoningBuffer.trim()) flushReasoning();
    const separator = reasoningBuffer.trim() ? "\n\n" : "";
    reasoningBuffer = `${reasoningBuffer}${separator}${assistantBuffer.trim()}`;
    assistantBuffer = "";
    assistantNeedsSeparator = false;
    reasoningKind = undefined;
  };

  // Everything the run says before it goes back to work is narration, wherever
  // in the turn it was said. A turn is therefore one Working block holding the
  // whole account of the work — orientation, tools, the report between rounds,
  // more tools — and the only prose left standing on the page is the answer.
  //
  // Letting a mid-turn report stand as its own message instead was the previous
  // rule, and it split one turn into "Worked for 4 seconds", a muted paragraph,
  // "Worked for 2 seconds", and only then the answer: three blocks for one
  // stretch of work, with a sentence marooned between them that read like a
  // reply and was not one.
  //
  // The cost is that a paragraph the reader may be mid-way through moves when
  // the next tool starts. It moves into the open block directly above it rather
  // than off the page, and the block is expanded while the run is live, so the
  // text lands close to where it was — which is the price of not stranding it.
  const narrateAssistantForActivity = () => {
    foldProseIntoNarration();
    flushReasoning();
  };

  for (const event of events) {
    if (event.type === "user.message") {
      flushReasoning();
      flushActivity();
      flushAssistant();
      const visiblePrompt = visibleReviewPrompt(event.text);
      items.push({
        type: "user",
        id: `user-${items.length}-${event.text.length}`,
        text: visiblePrompt.text,
        rawText: event.text,
        reviewFeedback: visiblePrompt.feedback,
        attachedFiles: (event.attachedFiles ?? []).map(normalizeAttachment),
      });
      activityStartedAt = event.at;
      activityEndedAt = undefined;
      continue;
    }
    if (event.type === "assistant.delta") {
      // Direct answers close the wait on the first token. After tools the burst
      // is still held in Working, so each token can extend the elapsed window
      // until the turn ends and that passage is promoted out.
      if (activityHasTools(activitySegments) || !assistantBuffer) {
        markActivityTime(undefined, event.at);
      }
      const separator = assistantNeedsSeparator
        && assistantBuffer.trim()
        && !/\s$/.test(assistantBuffer)
        && !/^\s/.test(event.text)
        ? "\n\n"
        : "";
      assistantBuffer = `${assistantBuffer}${separator}${event.text}`;
      assistantNeedsSeparator = false;
      continue;
    }
    if (event.type === "context.compaction") {
      // Compaction happens between the model's turns, not inside its thinking,
      // so it opens the Working block itself rather than waiting for a tool. A
      // finish updates the row that started it: the elapsed time the user
      // watched is the elapsed time that settles.
      if (event.phase === "started") {
        narrateAssistantForActivity();
        flushActivity();
        compactionIndex += 1;
        items.push({
          type: "compaction",
          id: `compaction-${compactionIndex}`,
          status: "running",
          startedAt: event.at,
        });
        continue;
      }
      const open = [...items].reverse().find(
        (item): item is Extract<ComposerTimelineItem, { type: "compaction" }> =>
          item.type === "compaction" && item.status === "running",
      );
      // A finish with no open marker means the start was never seen — a resumed
      // chat replaying a truncated event log. Nothing is invented for it.
      if (!open) continue;
      open.status = event.outcome ?? "unchanged";
      open.endedAt = event.at;
      if (event.reclaimedTokens !== undefined) open.reclaimedTokens = event.reclaimedTokens;
      continue;
    }
    if (event.type === "assistant.progress.delta") {
      // Prose already buffered came first, so it joins the passage ahead of
      // this line rather than being interleaved with it.
      foldProseIntoNarration();
      const nextKind = progressKind(event);
      if (reasoningBuffer.trim() && reasoningKind !== nextKind) flushReasoning();
      reasoningKind = nextKind;
      reasoningStartedAt = reasoningStartedAt ?? event.at;
      reasoningEndedAt = event.endedAt ?? event.at ?? reasoningEndedAt;
      reasoningBuffer = `${reasoningBuffer}${reasoningBuffer ? "\n\n" : ""}${event.text}`;
      continue;
    }
    if (event.type === "turn.outcome") {
      // Every outcome that reaches here is terminal, so this is where one turn
      // ends and the next begins. It has to close the answer: `assistant.done`
      // is emitted once per *run*, and a queued follow-up answers inside the
      // same run, so without this the second answer continued the first one's
      // buffer and the two rendered as a single message.
      //
      // After tools, live prose was held inside Working. Ending the turn is
      // what promotes the last passage out as the answer — including a stop,
      // which is still the last thing the run said.
      //
      // Block first, then the prose: the work came before the sentence that was
      // still arriving when the turn ended.
      flushReasoning();
      if (activityHasTools(activitySegments)) markActivityTime(undefined, event.at);
      flushActivity();
      flushAssistant();
      continue;
    }
    if (event.type === "assistant.done") {
      flushReasoning();
      if (activityHasTools(activitySegments)) markActivityTime(undefined, event.at);
      flushActivity();
      flushAssistant();

      continue;
    }
    if (event.type === "skill.requested") {
      narrateAssistantForActivity();
      skillIndex += 1;
      activitySegments.push({
        type: "skill",
        id: `skill-${skillIndex}`,
        skillId: event.skillId,
        source: event.source,
        origin: event.origin,
        status: "requested",
        requestId: event.requestId,
      });
      markActivityTime(event.at, event.endedAt ?? event.at);
      continue;
    }
    if (event.type === "skill.loaded" || event.type === "skill.failed") {
      narrateAssistantForActivity();
      const existing = [...activitySegments].reverse().find(
        (segment): segment is Extract<ComposerActivitySegment, { type: "skill" }> =>
          segment.type === "skill" && segment.requestId === event.requestId,
      );
      if (existing) {
        existing.status = event.type === "skill.loaded" ? "loaded" : "failed";
        if (event.type === "skill.loaded") {
          existing.contentHash = event.contentHash;
          existing.bytes = event.bytes;
        } else {
          existing.code = event.code;
          existing.message = event.message;
        }
      } else {
        skillIndex += 1;
        activitySegments.push({
          type: "skill",
          id: `skill-${skillIndex}`,
          skillId: event.skillId,
          source: event.source,
          origin: event.origin,
          status: event.type === "skill.loaded" ? "loaded" : "failed",
          requestId: event.requestId,
          ...(event.type === "skill.loaded"
            ? { contentHash: event.contentHash, bytes: event.bytes }
            : { code: event.code, message: event.message }),
        });
      }
      markActivityTime(event.at, event.endedAt ?? event.at);
      continue;
    }
    if (event.type === "command.started") {
      narrateAssistantForActivity();
      const existingRun = runs.get(event.id);
      if (existingRun) {
        existingRun.command = event.command;
        existingRun.kind = event.kind;
        existingRun.toolKind = event.toolKind;
        existingRun.commandClass = event.commandClass;
        existingRun.cwd = event.cwd;
        existingRun.startedAt = existingRun.startedAt ?? event.at;
        existingRun.endedAt = event.at ?? existingRun.endedAt;
        if (ensureCommandSegment(existingRun)) {
          markActivityTime(event.at, event.at);
        }
        continue;
      }
      const run: CommandRun = {
        id: event.id,
        command: event.command,
        kind: event.kind,
        toolKind: event.toolKind,
        commandClass: event.commandClass,
        cwd: event.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
        startedAt: event.at,
        endedAt: event.at,
      };
      runs.set(event.id, run);
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.at);
      }
      continue;
    }
    if (event.type === "command.output") {
      narrateAssistantForActivity();
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.endedAt ?? event.at,
        };
        runs.set(event.id, run);
      }
      run.endedAt = event.endedAt ?? event.at ?? run.endedAt;
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.endedAt ?? event.at);
      }
      if (event.stream === "stdout") {
        run.stdout = `${run.stdout}${event.text}`;
      } else {
        run.stderr = `${run.stderr}${event.text}`;
      }
      continue;
    }
    if (event.type === "command.finished") {
      narrateAssistantForActivity();
      let run = runs.get(event.id);
      if (!run) {
        run = {
          id: event.id,
          command: event.id,
          kind: "bash",
          cwd: "",
          stdout: "",
          stderr: "",
          exitCode: null,
          status: "running",
          startedAt: event.at,
          endedAt: event.at,
        };
        runs.set(event.id, run);
      }
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "passed" : "failed";
      run.resultStatus = event.status;
      run.errorCode = event.errorCode;
      if (event.errorMessage && !run.stderr.trim()) run.stderr = event.errorMessage;
      run.endedAt = event.at ?? run.endedAt;
      run.durationMs = event.durationMs;
      if (ensureCommandSegment(run)) {
        markActivityTime(event.at, event.at);
      }
      continue;
    }
    if (event.type === "task.error") {
      flushReasoning();
      if (activitySegments.length) {
        markActivityTime(undefined, event.at);
      } else {
        activityStartedAt = undefined;
        activityEndedAt = undefined;
      }
      flushActivity();
      assistantBuffer = `${assistantBuffer}${assistantBuffer.trim() ? "\n\n" : ""}I couldn't complete this request.\n\n${event.message}`;
      flushAssistant();
    }
  }
  // After tools have run, live prose stays inside Working until the turn ends.
  // It might still be a mid-round report; promoting it on the first token made
  // that report look like the answer, then jump back in when the next tool
  // started. Direct answers (no tools yet) still stream outside from the first
  // token, so a question with no work never grows a Working block around the
  // reply.
  const answering = assistantBuffer.trim().length > 0;
  const holdInBlock = taskState === "running" && answering && activityHasTools(activitySegments);
  if (holdInBlock) {
    foldProseIntoNarration();
    flushReasoning(false, true);
    flushActivity(false);
  } else {
    flushReasoning(taskState !== "running" || answering);
    flushActivity(taskState !== "running" || answering);
    flushAssistant(taskState === "running");
  }

  // The turn's answer is the prose nothing follows *within its own turn*.
  // Deciding it by position rather than by the run having settled is what keeps
  // it stable: a message stops being the answer the moment work opens beneath
  // it, and the real answer is the answer from its first streamed token — it
  // never restyles under the reader.
  //
  // "Nothing follows" has to stop at the next user message. Marking only the
  // last item of the whole transcript demoted every earlier turn's answer to
  // narration the instant the next message was sent, so a finished reply shrank
  // to muted 11px prose while the reader was looking at it.
  for (const [index, item] of items.entries()) {
    if (item.type !== "assistant") continue;
    const next = items[index + 1];
    if (!next || next.type === "user") {
      item.final = true;
    }
  }

  return items;
}
