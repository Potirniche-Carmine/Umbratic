import type { TaskPermissionRequest } from "./taskEventReducer";

export type CommandClass =
  | "read"
  | "edit"
  | "shell"
  | "python-runtime"
  | "markdown"
  | "cmake-build"
  | "compiler"
  | "package-manager"
  | "git-read"
  | "git-write"
  | "destructive-file"
  | "network"
  | "external-directory"
  | "unknown";

export type CommandRun = {
  id: string;
  command: string;
  kind?: TaskPermissionRequest["kind"];
  toolKind?: string;
  commandClass?: CommandClass;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: "running" | "passed" | "failed";
  resultStatus?: string;
  errorCode?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

const commandOutputPreviewCharacterLimit = 12000;
const commandOutputPreviewLineLimit = 5;

// Every runner tool that is not a shell command. Keyed by the tool name the
// runner reports, so a new tool cannot silently fall through to shell rendering.
const workspaceToolLabels: Record<string, string> = {
  read: "Read workspace",
  read_attachment: "Read attachment",
  read_skill: "Read skill",
  ls: "List directory",
  find: "Find paths",
  grep: "Search text",
  write: "Write file",
  edit: "Edit files",
  apply_patch: "Edit files",
  lsp: "Inspect code",
  workspace_graph: "Inspect code",
  retrieve_context: "Retrieve context",
};

function isShellRun(run: CommandRun): boolean {
  if (run.toolKind) return !(run.toolKind in workspaceToolLabels);
  return run.kind === "bash" || !run.kind;
}

export function commandLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "Workspace action";
  if (/^grep(?:\s|$)/i.test(trimmed)) return "Search text";
  if (/^find(?:\s|$)/i.test(trimmed)) return "Find paths";
  if (/^ls(?:\s|$)/i.test(trimmed)) return "List directory";
  if (/^read(?:\s|$)/i.test(trimmed)) return "Read workspace";
  if (/^write(?:\s|$)/i.test(trimmed)) return "Write file";
  if (/^edit(?:\s|$)/i.test(trimmed)) return "Edit files";
  if (/^(rg|grep|find|fd)\b/i.test(trimmed)) return "Search";
  if (/^npm\b.+\brun\b/i.test(trimmed)) return "Run script";
  if (/^git\b/i.test(trimmed)) return "Git";
  if (/^(node|python|python3)\b/i.test(trimmed)) return "Runtime";
  return trimmed.split(/\s+/).slice(0, 2).join(" ");
}

function runLabel(run: CommandRun): string {
  const toolLabel = run.toolKind ? workspaceToolLabels[run.toolKind] : undefined;
  return toolLabel ?? commandLabel(run.command);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function previewTail(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(-limit), truncated: true };
}

function hidesReadValidationDetails(run: CommandRun): boolean {
  return run.toolKind === "read" && run.resultStatus === "validation_error";
}

export function commandVisibleOutput(run: CommandRun): string {
  if (hidesReadValidationDetails(run)) return "";
  return [run.stdout, run.stderr].filter(Boolean).join("\n");
}

export function commandHasVisibleDetails(run: CommandRun): boolean {
  return isShellRun(run) || commandVisibleOutput(run).trim().length > 0;
}

export function commandSummary(run: CommandRun): string {
  if (run.status === "running") return "running";
  const outputPreview = previewTail(commandVisibleOutput(run), commandOutputPreviewCharacterLimit);
  const output = stripAnsi(outputPreview.text).trim();
  const lastLine = output.split(/\r?\n/).filter(Boolean).slice(-1)[0];
  if (run.status === "failed") {
    const exit = `exit ${run.exitCode ?? "unknown"}`;
    return lastLine ? `${exit}: ${lastLine}` : exit;
  }
  return output ? output.split(/\r?\n/).filter(Boolean).slice(-1)[0] : `exit ${run.exitCode ?? 0}`;
}

export function commandShellText(run: CommandRun): string {
  const isTool = !isShellRun(run);
  const parts = isTool ? [] : [`$ ${run.command}`];
  const outputPreview = previewTail(commandVisibleOutput(run), commandOutputPreviewCharacterLimit);
  const output = stripAnsi(outputPreview.text).trimEnd();
  if (output) {
    const outputLines = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const lineTruncated = outputLines.length > commandOutputPreviewLineLimit;
    if (outputPreview.truncated || lineTruncated) {
      const visibleLines = outputLines.slice(-(commandOutputPreviewLineLimit - 1));
      const marker = outputPreview.truncated
        ? "[Earlier output omitted.]"
        : `[${outputLines.length - visibleLines.length} earlier output line${outputLines.length - visibleLines.length === 1 ? "" : "s"} omitted.]`;
      parts.push([marker, ...visibleLines].join("\n"));
    } else {
      parts.push(output);
    }
  }
  if (isTool && !parts.length) parts.push(commandSummary(run));
  return parts.join("\n\n");
}

export function commandDetailLabel(run: CommandRun): string {
  const label = isShellRun(run) ? "Shell" : `${runLabel(run)} results`;
  return run.commandClass ? `${label} - ${run.commandClass}` : label;
}

export function activityToolLabel(run: CommandRun): { key: string; label: string } {
  const fileTool = run.command.trim().match(/^(read|write|edit)\s+([^\s]+)/i);
  if (fileTool) {
    const target = fileTool[2].replaceAll("\\", "/");
    const name = target.split("/").filter(Boolean).at(-1) ?? target;
    const action = `${fileTool[1][0].toUpperCase()}${fileTool[1].slice(1).toLowerCase()}`;
    return { key: `${action.toLowerCase()}:${target.toLowerCase()}`, label: `${action} ${name}` };
  }
  const label = runLabel(run);
  return { key: label.toLowerCase(), label };
}
