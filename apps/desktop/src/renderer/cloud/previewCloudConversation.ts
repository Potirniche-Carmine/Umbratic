import type { CloudApi, CloudProvider, CloudWorkspace } from "../../shared/cloud";

/** Deterministic streaming fixture; contains no provider or microphone access. */
export function previewCloudConversation(): Pick<CloudApi, "getCloudWorkspace" | "onCloudWorkspace" | "startCloudTurn" | "stopCloudTurn" | "resetCloudContext"> {
  const showActivity = new URLSearchParams(window.location.search).get("activity") === "1";
  const workspace: CloudWorkspace = { key: "preview-conversation", provider: "claude", path: "/preview", state: "idle", compactions: 0,
    account: "Preview account", contextWindow: 1_000_000, inputTokens: 26_491, approvals: [], entries: [
      { id: "hello", kind: "instruction", text: "Hey there", at: new Date().toISOString() },
      { id: "answer", kind: "answer", text: "Hey! What would you like to work on?", at: new Date().toISOString() },
    ] };
  const listeners = new Set<(workspace: CloudWorkspace) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => listeners.forEach(listener => listener(structuredClone(workspace)));
  const stop = () => { clearInterval(timer); workspace.state = "idle"; publish(); };
  return {
    getCloudWorkspace: async ({ provider }: { provider: CloudProvider }) => { workspace.provider = provider; return structuredClone(workspace); },
    onCloudWorkspace: callback => { listeners.add(callback); return () => { listeners.delete(callback); if (!listeners.size) clearInterval(timer); }; },
    startCloudTurn: async ({ prompt, provider }) => {
      workspace.provider = provider; workspace.state = "running";
      const instruction = { id: crypto.randomUUID(), kind: "instruction" as const, text: prompt, at: new Date().toISOString(), completedAt: undefined as string | undefined };
      workspace.entries.push(instruction);
      const tool = { id: crypto.randomUUID(), label: "Check workspace", kind: "bash", detail: "npm test", output: "Starting checks…", status: "running" as "running" | "completed" };
      if (showActivity) workspace.entries.push(
        { id: crypto.randomUUID(), kind: "answer", phase: "commentary", text: "I’ll check the workspace and report the result.", at: new Date().toISOString() },
        ...["cat package.json", "rg -n dictation src/renderer", "git diff --stat"].map(command => ({ id: crypto.randomUUID(), kind: "activity" as const, text: "Run command", at: new Date().toISOString(), tool: { id: crypto.randomUUID(), label: "Run command", kind: "bash", detail: `/bin/zsh -lc '${command}'`, status: "completed" as const } })),
        { id: crypto.randomUUID(), kind: "activity", text: tool.label, tool, at: new Date().toISOString() },
      );
      const answer = { id: crypto.randomUUID(), kind: "answer" as const, text: "", at: new Date().toISOString() };
      workspace.entries.push(answer);
      const text = showActivity ? "The controls now share the same inner height, keeping the waveform and microphone menu aligned.\n\nSee [dictation control alignment:13](/preview/src/dictation.ts:13)." : "This is a streaming preview. Paragraphs stay in place as the next block arrives.\n\nThe composer stays at the bottom while the conversation grows. **Formatting stays stable**, including lists and code.\n\n- Keep your place when scrolling up.\n- Follow new text while reading at the bottom.\n\n```ts\nconst message = 'Ready when you are';\nconsole.log(message);\n```\n\nUpdated [dictation control alignment:13](/preview/src/dictation.ts:13).";
      let ticks = 0;
      timer = setInterval(() => {
        if (showActivity && ticks++ < 12) { tool.output += "\nCheck passed."; publish(); return; }
        tool.status = "completed";
        answer.text = text.slice(0, answer.text.length + 7);
        if (answer.text === text) { instruction.completedAt = new Date().toISOString(); stop(); } else publish();
      }, 80);
      publish(); return structuredClone(workspace);
    },
    stopCloudTurn: async () => stop(),
    resetCloudContext: async () => { stop(); workspace.entries = []; publish(); return structuredClone(workspace); },
  };
}
