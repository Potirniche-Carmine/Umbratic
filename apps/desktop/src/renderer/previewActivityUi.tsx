/** Browser-only fixtures for shared activity and interim speech; no microphone or provider access. */
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptTextarea } from "./PromptTextarea";
import { WorkingBlock } from "./workingBlock";
import type { ComposerTimelineItem } from "./rendererTypes";

function PreviewActivityUi() {
  const [mode, setMode] = useState("cloud");
  const [draft, setDraft] = useState("Please update the settings.");
  const [recording, setRecording] = useState(true);
  const [finished, setFinished] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tools, setTools] = useState(new Set<string>());
  const follow = useRef(new Map<string, boolean>());
  const text = "Make the dictation text muted and show commands directly in the activity list.";
  const item: Extract<ComposerTimelineItem, { type: "activity" }> = {
    type: "activity", id: "preview-work", startedAt: "2026-11-03T12:00:00Z", endedAt: finished ? "2026-11-03T12:00:20Z" : undefined, finished,
    segments: [
      { type: "reasoning", id: "progress", text: "I’ll check the dictation controls and tidy the activity list.", finished: true, durationMs: null },
      ...["read src/renderer/PromptTextarea.tsx", "read src/renderer/workingBlock.tsx", "edit src/renderer/ActivityTools.tsx", "npm test"].map((command, i) => ({ type: "command" as const, id: `tool-${i}`, run: {
        id: `tool-${i}`, command, cwd: "/preview", stdout: "All checks passed.", stderr: "", exitCode: finished || i < 3 ? 0 : null,
        status: finished || i < 3 ? "passed" as const : "running" as const,
        toolKind: i < 2 ? "read" : i === 2 ? "edit" : "bash",
      } })),
    ],
  };
  return <main className="unifiedWorkspace" style={{ maxWidth: 760, margin: "40px auto", padding: 24 }}>
    <nav style={{ display: "flex", gap: 20, marginBottom: 30 }}>
      <button onClick={() => setMode(mode === "cloud" ? "private" : "cloud")}>{mode === "cloud" ? "Show Private" : "Show Cloud"}</button>
      <button onClick={() => setFinished(value => !value)}>{finished ? "Start work" : "Finish work"}</button>
      <button onClick={() => { if (recording) setDraft(value => `${value} ${text}`); setRecording(value => !value); }}>{recording ? "Finish dictation" : "Start dictation"}</button>
    </nav>
    <WorkingBlock item={item} clock={Date.parse("2026-11-03T12:00:20Z")} expanded={expanded.has(item.id)} expandedToolIds={tools} skills={[]} followScrollRef={follow}
      setExpanded={setExpanded} setExpandedTools={setTools} setBodyRef={() => {}} onPointerDown={() => {}} onScroll={() => {}} onTouchMove={() => {}} onWheel={() => {}}/>
    <div className={mode === "cloud" ? "" : "composer"} style={{ marginTop: 36, position: "relative", width: "100%", bottom: "auto" }}>
      <div className={`promptInputShell ${mode === "cloud" ? "cloudDock" : ""}`}>
        <div className="promptAttachmentStrip"/>
        <div className="promptEditor">
          {mode === "private" && <div className="promptHighlight promptTextLayout" aria-hidden="true">{draft}</div>}
          <PromptTextarea value={draft} aria-label="Prompt" onChange={event => setDraft(event.target.value)} previewCaret={draft.length}
            dictation={{ state: recording ? "recording" : "idle", preview: recording ? text : "", level: 0, error: null }}/>
        </div>
        <div className="promptActionRail"/>
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<PreviewActivityUi/>);
