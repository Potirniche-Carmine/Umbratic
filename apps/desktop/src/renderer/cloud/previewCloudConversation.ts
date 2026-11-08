import type { CloudApi, CloudProvider, CloudWorkspace, CloudWorkspaceInput, CloudImage } from "../../shared/cloud";

/** Deterministic streaming fixture; contains no provider or microphone access. */
export function previewCloudConversation(images = new Map<string, CloudImage>()): Pick<CloudApi, "getCloudWorkspace" | "onCloudWorkspace" | "startCloudTurn" | "sendCloudFollowUp" | "removeCloudQueuedPrompt" | "stopCloudTurn" | "listCloudChats" | "createCloudChat" | "deleteCloudChat"> {
  const showActivity = new URLSearchParams(window.location.search).get("activity") === "1";
  const initial: CloudWorkspace = { key: "preview-conversation", provider: "claude", path: "/preview", state: "idle", compactions: 0,
    account: "Preview account", contextWindow: 1_000_000, inputTokens: 26_491, approvals: [], entries: [
      { id: "hello", kind: "instruction", text: "Hey there", at: new Date().toISOString() },
      { id: "answer", kind: "answer", text: "Hey! What would you like to work on?", at: new Date().toISOString() },
    ] };
  const workspaces = new Map<string, CloudWorkspace>((["codex", "claude"] as const).map(provider => {
    const key = `preview-conversation-${provider}`;
    return [key, { ...structuredClone(initial), key, chatId: key, provider }];
  }));
  const listeners = new Set<(workspace: CloudWorkspace) => void>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const publish = (workspace: CloudWorkspace) => listeners.forEach(listener => listener(structuredClone(workspace)));
  const stop = (workspace: CloudWorkspace) => { clearInterval(timers.get(workspace.key)); timers.delete(workspace.key); workspace.state = "idle"; publish(workspace); };
  function find(input: CloudWorkspaceInput): CloudWorkspace {
    const workspace = workspaces.get(input.key || `preview-conversation-${input.provider}`);
    if (!workspace || workspace.provider !== input.provider) throw new Error("Chat not found for this provider.");
    return workspace;
  }
  const api: ReturnType<typeof previewCloudConversation> = {
    listCloudChats: async ({ provider }) => [...workspaces.values()].filter(chat => chat.provider === provider).map(chat => ({ key: chat.key, provider, title: chat.entries.find(entry => entry.kind === "instruction")?.text || "New chat", paths: [chat.path], state: chat.state, updatedAt: chat.lastActiveAt || "" })),
    createCloudChat: async ({ provider }) => { const key = crypto.randomUUID(); const chat: CloudWorkspace = { key, chatId: key, provider, path: "/preview", state: "idle", compactions: 0, entries: [], approvals: [], lastActiveAt: new Date().toISOString() }; workspaces.set(key, chat); publish(chat); return structuredClone(chat); },
    deleteCloudChat: async ({ key, provider }) => { const chat = find({ key, provider }); stop(chat); workspaces.delete(key); },
    getCloudWorkspace: async input => structuredClone(find(input)),
    onCloudWorkspace: callback => { listeners.add(callback); return () => { listeners.delete(callback); if (!listeners.size) { for (const timer of timers.values()) clearInterval(timer); timers.clear(); } }; },
    startCloudTurn: async input => {
      if (!input.key && input.chatId) {
        const key = input.chatId;
        workspaces.set(key, { key, chatId: key, provider: input.provider, path: "/preview", repositoryIds: input.repositoryIds || [], state: "idle", compactions: 0, entries: [], approvals: [] });
        input = { ...input, key };
      }
      const workspace = find(input); const { prompt } = input;
      workspace.state = "running"; workspace.lastActiveAt = new Date().toISOString();
      const instruction = { id: crypto.randomUUID(), kind: "instruction" as const, text: prompt, images: input.imageIds?.flatMap(id => images.get(id) || []), at: new Date().toISOString(), completedAt: undefined as string | undefined };
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
      const timer = setInterval(() => {
        if (showActivity && ticks++ < 12) { tool.output += "\nCheck passed."; publish(workspace); return; }
        tool.status = "completed";
        answer.text = text.slice(0, answer.text.length + 7);
        if (answer.text === text) {
          for (const entry of workspace.entries) if (entry.kind === "instruction") entry.completedAt ??= new Date().toISOString();
          stop(workspace);
          const next = workspace.queuedPrompts?.shift();
          if (next) void api.startCloudTurn({ provider: workspace.provider, key: workspace.key, prompt: next.prompt, imageIds: next.images.map(image => image.id) });
        } else publish(workspace);
      }, 80);
      timers.set(workspace.key, timer); publish(workspace); return structuredClone(workspace);
    },
    stopCloudTurn: async ({ key }) => { const chat = workspaces.get(key); if (chat) stop(chat); },
    sendCloudFollowUp: async input => {
      const workspace = workspaces.get(input.key);
      if (!workspace) throw new Error("Chat not found.");
      const queued = workspace.queuedPrompts?.find(item => item.id === input.queuedId);
      const prompt = queued?.prompt ?? input.prompt;
      const attached = queued?.images ?? input.imageIds?.flatMap(id => images.get(id) || []) ?? [];
      if (workspace.state === "idle") {
        workspace.queuedPrompts = workspace.queuedPrompts?.filter(item => item.id !== queued?.id);
        return api.startCloudTurn({ provider: workspace.provider, key: workspace.key, prompt, imageIds: attached.map(image => image.id) });
      }
      if (input.mode === "queue") (workspace.queuedPrompts ??= []).push({ id: crypto.randomUUID(), prompt, images: attached });
      else {
        workspace.entries.push({ id: crypto.randomUUID(), kind: "instruction", text: prompt, images: attached, at: new Date().toISOString() });
        workspace.queuedPrompts = workspace.queuedPrompts?.filter(item => item.id !== queued?.id);
      }
      publish(workspace); return structuredClone(workspace);
    },
    removeCloudQueuedPrompt: async ({ key, id }) => {
      const workspace = workspaces.get(key);
      if (!workspace) throw new Error("Chat not found.");
      workspace.queuedPrompts = workspace.queuedPrompts?.filter(item => item.id !== id);
      publish(workspace); return structuredClone(workspace);
    },
  };
  return api;
}
