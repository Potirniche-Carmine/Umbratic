import { activityToolLabel, type CommandRun } from "./commandDisplay";
import type { ComposerActivitySegment } from "./rendererTypes";

export type ToolSegment = Exclude<ComposerActivitySegment, { type: "reasoning" }>;
export type ToolGroup = { type: "tools"; id: string; segments: ToolSegment[] };

/** Only adjacent tool actions share a disclosure; narration keeps its place. */
export function groupActivitySegments(segments: ComposerActivitySegment[]): (Extract<ComposerActivitySegment, { type: "reasoning" }> | ToolGroup)[] {
  const groups: (Extract<ComposerActivitySegment, { type: "reasoning" }> | ToolGroup)[] = [];
  for (const segment of segments) {
    if (segment.type === "reasoning") { groups.push(segment); continue; }
    const previous = groups.at(-1);
    if (previous?.type === "tools") previous.segments.push(segment);
    else groups.push({ type: "tools", id: segment.id, segments: [segment] });
  }
  return groups;
}

export function unwrappedCommand(command: string): string {
  const shell = command.trim().match(/^(?:\S*[/\\])?(?:bash|zsh|sh|fish)\s+-(?:lc|c)\s+([\s\S]+)$/);
  if (!shell) return command.trim();
  const value = shell[1];
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("'\\''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

export function activityCommandPresentation(run: CommandRun): { kind: "command" | "read" | "edit" | "search" | "tool"; verb: string; target: string } {
  const native = run.nativeDisplay?.label || "";
  const type = (run.toolKind || native).toLowerCase();
  let input: Record<string, unknown> = {};
  try { const parsed = JSON.parse(run.nativeDisplay?.detail.split("\n\n")[0] || "{}"); if (parsed && typeof parsed === "object") input = parsed; } catch { /* Native shell commands and paths are already displayable. */ }
  const command = unwrappedCommand(typeof input.command === "string" ? input.command : run.command);
  const firstLine = command.split("\n")[0];
  const filename = (value: string) => value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || value;
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
  const failed = run.status === "failed";
  const live = run.status === "running";
  if (/^(read|read file)$/.test(type) || /^read\s+/.test(command)) return { kind: "read", verb: failed ? "Could not read" : live ? "Reading" : "Read", target: filename(file || command.replace(/^read\s+/, "")) };
  if (/^(edit files|edit|write|multiedit|apply_patch)$/.test(type) || /^(write|edit|apply_patch)\s+/.test(command)) return { kind: "edit", verb: failed ? "Could not edit" : live ? "Editing" : "Edited", target: filename(file || firstLine.replace(/^(write|edit|apply_patch)\s+/, "")) };
  if (/^(grep|glob|search|search the web|websearch|web_search)$/.test(type)) return { kind: "search", verb: live ? "Searching" : "Searched", target: String(input.pattern || input.query || firstLine) };
  if (!run.toolKind || /^(bash|shell|commandexecution)$/.test(type) || native === "Run command") {
    // Old native file actions may have no structured tool kind. Preserve their label.
    if (!native || native === "Run command" || /^(bash|shell)$/i.test(native) || run.toolKind === "bash") return { kind: "command", verb: failed ? "Failed" : live ? "Running" : "Ran", target: command };
  }
  return { kind: "tool", verb: "", target: activityToolLabel(run).label };
}

export function activityGroupSummary(segments: ToolSegment[]): string {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const kind = segment.type === "skill" ? "skill" : activityCommandPresentation(segment.run).kind;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  const labels: Record<string, [string, string]> = { command: ["command", "commands"], read: ["file read", "file reads"], edit: ["edit", "edits"], search: ["search", "searches"], tool: ["tool call", "tool calls"], skill: ["skill", "skills"] };
  return [...counts].map(([kind, count]) => `${count} ${labels[kind][count === 1 ? 0 : 1]}`).join(" · ");
}

export function visibleActivityTools(segments: ToolSegment[], expanded: boolean, finished: boolean): ToolSegment[] {
  if (segments.length < 4 || expanded) return segments;
  if (finished) return [];
  const running = segments.filter(segment => segment.type === "command" && segment.run.status === "running");
  return running.length ? running : segments.slice(-1);
}
