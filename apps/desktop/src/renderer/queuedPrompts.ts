import type { ChatAttachment, DesktopApi } from "../shared/desktopApi";
import type { QueuedComposerPrompt } from "./rendererTypes";

/// The runner holds queued messages and releases one only after a turn delivers
/// its final answer. The renderer therefore mirrors that list rather than
/// tracking its own: a message released while this window was closed, reloaded,
/// or simply not looking must not survive as a row that will never run.
export async function readQueuedPrompts(
  api: Pick<DesktopApi, "listQueuedTaskPrompts">,
  taskId: string,
): Promise<QueuedComposerPrompt[]> {
  const queued = await api.listQueuedTaskPrompts({ taskId });
  return queued.map((item) => toQueuedPrompt(taskId, item));
}

export function toQueuedPrompt(
  taskId: string,
  item: { actionId: string; prompt: string; attachedFiles: ChatAttachment[] },
): QueuedComposerPrompt {
  return {
    prompt: item.prompt,
    attachedFiles: item.attachedFiles,
    reviewFeedback: [],
    id: `queued-${item.actionId}`,
    taskId,
    actionId: item.actionId,
  };
}
