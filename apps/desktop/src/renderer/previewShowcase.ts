import type { BackendUiEvent, TaskInfo } from "../shared/desktopApi";

/** Public screenshot content, rendered by the real UI without provider calls. */
export function showcaseTask(task: TaskInfo): TaskInfo {
  const prompt = "Simplify the review panel and keep feedback close to the file I’m working on.";
  const at = new Date().toISOString();
  const events: BackendUiEvent[] = [
    { type: "user.message", taskId: task.id, text: prompt, at },
    { type: "assistant.delta", taskId: task.id, at, text: "The review panel now keeps the next step close.\n\n- Switch between unified and side-by-side changes.\n- Leave feedback on the lines you’re reviewing.\n- Open the selected file in your editor.\n\nThe toolbar uses compact controls, leaving more room for the code." },
  ];
  return { ...task, prompt, events };
}
