import type { CloudEntry } from "../../shared/cloud";
import type { ComposerTimelineItem, ComposerActivitySegment } from "../rendererTypes";

type Activity = Extract<ComposerTimelineItem, { type: "activity" }>;

export function cloudTurns(entries: CloudEntry[], running: boolean): { instruction?: CloudEntry; activity: Activity; answer?: CloudEntry; notes: CloudEntry[] }[] {
  const groups: CloudEntry[][] = [];
  for (const entry of entries) {
    if (entry.kind === "instruction" || !groups.length) groups.push([]);
    groups.at(-1)!.push(entry);
  }
  return groups.map((group, index) => {
    const instruction = group.find(entry => entry.kind === "instruction");
    const finished = !!instruction?.completedAt || !running || index !== groups.length - 1;
    const last = [...group].reverse().find(entry => entry.kind === "answer" && entry.text && entry.phase !== "commentary");
    // A passage followed by work is progress, even after that tool completes.
    // Providers without message phases reveal their final passage at turn end.
    const workAfter = last && group.slice(group.indexOf(last) + 1).some(entry => entry.kind === "activity" || entry.kind === "thinking");
    const answer = !workAfter && (finished || last?.phase === "final_answer") ? last : undefined;
    const segments: ComposerActivitySegment[] = group.flatMap(entry => {
      if ((entry.kind === "answer" && entry !== answer) || entry.kind === "thinking") {
        return [{ type: "reasoning", id: entry.id, text: entry.text, kind: entry.kind === "thinking" ? "thinking" : undefined,
          durationMs: null, finished: finished || entry !== group.at(-1) } as ComposerActivitySegment];
      }
      if (entry.kind !== "activity") return [];
      const tool = entry.tool;
      return [{ type: "command", id: entry.id, run: {
        id: entry.id, command: tool?.detail || entry.text, toolKind: tool?.kind,
        nativeDisplay: { label: (tool?.label || entry.text) + (tool?.status === "stopped" ? " · stopped" : ""), detail: [tool?.detail || entry.text, tool?.output].filter(Boolean).join("\n\n") },
        cwd: "", stdout: tool?.output || "", stderr: "", exitCode: null,
        status: tool?.status === "running" ? "running" : tool?.status === "failed" ? "failed" : "passed", resultStatus: tool?.status, startedAt: entry.at,
      } } as ComposerActivitySegment];
    });
    return { instruction, answer,
      activity: { type: "activity", id: `work-${group[0].id}`, segments, startedAt: group[0].at, endedAt: finished ? instruction?.completedAt || group.at(-1)!.at : undefined, finished },
      notes: group.filter(entry => entry.kind === "context") };
  });
}
