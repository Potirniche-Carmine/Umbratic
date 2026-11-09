import type { CloudMessagePhase } from "../shared/cloud";
import type { CloudRuntimeSink } from "./cloudRuntimeTypes";
import type { RpcMessage } from "./cloudTransport";

type NativeItem = Record<string, any>;

/** One consumer per turn, retaining just the bounded in-flight tool output. */
export function codexStreamConsumer(sink: CloudRuntimeSink): (message: RpcMessage) => void {
  const items = new Map<string, NativeItem>();
  const phases = new Map<string, CloudMessagePhase>();
  return ({ method, params = {} }) => {
    if (method === "item/agentMessage/delta") sink.text(params.itemId, params.delta, true, phases.get(params.itemId));
    if (method === "item/plan/delta") sink.text(`plan:${params.itemId}`, params.delta, true, "commentary");
    if (method === "item/reasoning/summaryTextDelta") sink.thinking?.(`${params.itemId}:${params.summaryIndex ?? 0}`, params.delta, true);
    if (method === "item/commandExecution/outputDelta") {
      const item = items.get(params.itemId);
      if (item) {
        item.aggregatedOutput = ((item.aggregatedOutput || "") + params.delta).slice(-12000);
        sink.activity(itemLabel(item), toolItem(item, "running"));
      }
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = params.item;
    if (!item) return;
    const completed = method === "item/completed";
    if (item.type === "agentMessage") {
      if (item.phase) phases.set(item.id, item.phase);
      if (completed || item.text) sink.text(item.id, item.text || "", false, phases.get(item.id));
      if (completed) phases.delete(item.id);
    } else if (item.type === "reasoning") {
      // Only provider-supplied readable summaries; opaque/redacted content is ignored.
      for (const [index, text] of (item.summary || []).entries()) sink.thinking?.(`${item.id}:${index}`, text, false);
    } else if (item.type === "plan") {
      if (completed || item.text) sink.text(`plan:${item.id}`, item.text || "", false, "commentary");
    } else if (item.type !== "userMessage") {
      const merged = { ...items.get(item.id), ...item };
      sink.activity(itemLabel(merged), toolItem(merged, completed
        ? item.status === "failed" || item.status === "declined" || item.success === false || (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed" : "completed"
        : "running"));
      if (completed) items.delete(item.id); else items.set(item.id, merged);
      if (completed && item.type === "contextCompaction") sink.compact();
    }
  };
}

function itemLabel(item: NativeItem): string {
  if (item.type === "commandExecution") return "Run command";
  if (item.type === "fileChange") return "Edit files";
  if (item.type === "contextCompaction") return "Compact context";
  if (item.type === "webSearch") return "Search the web";
  if (item.type === "collabAgentToolCall" || item.type === "collabToolCall") return "Delegate task";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return item.tool || "Use tool";
  return "Work";
}

function toolItem(item: NativeItem, status: "running" | "completed" | "failed") {
  const detail = item.command || item.query || (item.changes || []).map((change: { path: string; diff?: string }) => [change.path, change.diff].filter(Boolean).join("\n")).join("\n\n") || item.tool || "";
  const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-12000) : undefined;
  const kind = item.type === "commandExecution" ? "bash" : item.type === "fileChange" ? "edit" : item.type === "webSearch" ? "web_search" : item.type;
  return { id: String(item.id), label: itemLabel(item), kind, detail: detail.slice(0, 12000), ...(output !== undefined ? { output } : {}), status };
}
