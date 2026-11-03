import { useCloudChats } from "./useCloudChats";
import { CloudChatArchive } from "./CloudChatArchive";
import { type WorkspaceSurfaceProps } from "../WorkspaceNavigation";
import React, { useMemo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Send, Paperclip, PanelRight, RotateCcw, Square, Settings2 } from "lucide-react";
import type { DesktopApi, RepositoryInfo } from "../../shared/desktopApi";
import { modelChoiceError, type CloudImage, type CloudSettings, type CloudChatRecord, type CloudProvider } from "../../shared/cloud";
import type { ReviewFile } from "../../shared/reviewDiff";
import { ReviewPanel } from "../review/ReviewPanel";
import { ReviewFeedbackChip, ReviewFeedbackDialog } from "../review/ReviewFeedbackDialog";
import { appendReviewFeedback, reviewCommentLineLabel } from "../review/reviewComments";
import { ShortcutTooltip } from "../Tooltip";
import { useCloudShortcuts } from "./useCloudShortcuts";
import { ErrorToast } from "../errorToast";
import { PromptTextarea } from "../PromptTextarea";
import { promptEnterAction } from "../promptKeyboard";
import { composerPromptForSend, insertPastedComposerText } from "../composerText";
import { fileToPastedAttachment } from "../pastedAttachments";
import { AttachmentPreviewList } from "../attachmentPreview";
import { CloudAttachmentPreview } from "./CloudAttachmentPreview";
import { CloudResetDialog } from "./CloudResetDialog";
import { CloudRunControls } from "./CloudRunControls";
import { useDictation, insertTranscript } from "../dictation";
import { DictationControl } from "../ComposerControls";
import { CloudFilePreview } from "./CloudFilePreview";
import { latestCloudUsage } from "../../shared/cloudUsage";
import { CloudModelPicker } from "./CloudModelPicker";
import { CloudApprovalCard } from "./CloudApprovalCard";
import { CloudSelect } from "./CloudSelect";
import { CloudFolders } from "./CloudFolders";
import { CloudTimeline, cloudImageAttachment } from "./CloudTimeline";
import { CloudUsageIndicator } from "./CloudUsage";
import type { CloudConnectionController } from "./useCloudConnection";
import type { SettingsTab } from "../SettingsNav";
import { ComposerActionRail } from "../ComposerActionRail";
import { ComposerGreeting } from "../composerChrome";

export function CloudWorkspace({ api, settings, onSettings, active, navigation, onActivity, controllers, settingsVisible, cloudBusy, onOpenSettings }: {
  controllers: Record<CloudProvider, CloudConnectionController>; settingsVisible: boolean; cloudBusy: boolean; onOpenSettings(tab: SettingsTab): void;
  api: DesktopApi; settings: CloudSettings; onSettings(settings: CloudSettings): Promise<void>;
} & WorkspaceSurfaceProps) {
  const [indexingPaths, setIndexingPaths] = useState<Set<string>>(new Set());
  useEffect(() => api.onWorkspaceIndex(event => setIndexingPaths(current => { const next = new Set(current); if (event.phase === "started") next.add(event.workspacePath); else next.delete(event.workspacePath); return next; })), [api]);
  const [projects, setProjects] = useState<RepositoryInfo[]>([]);
  const [filePreview, setFilePreview] = useState<{ path: string; line?: number }>();
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState("");
  const chat = useCloudChats(api, settings.provider, settings.workspaceRepositoryIds || [], setError);
  const { workspace, setWorkspace, prompt, setPrompt, images, setImages, feedback, setFeedback } = chat;
  const [deleteChat, setDeleteChat] = useState<CloudChatRecord[] | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<CloudImage>();
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [pending, setPending] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([]);
  const [reviewRoot, setReviewRoot] = useState("");
  const [reviewPath, setReviewPath] = useState("");
  const [reviewError, setReviewError] = useState("");
  const reviewCache = useRef(new Map<string, ReviewFile[]>());
  const scroller = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<CloudImage[]>([]); imagesRef.current = images;
  const pendingAttachments = useRef(0);
  const attachmentUrls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of attachmentUrls.current) URL.revokeObjectURL(url); attachmentUrls.current.clear(); }, []);
  useEffect(() => {
    const retained = new Set([...images, ...[...chat.drafts.current.values()].flatMap(draft => draft.images)].map(image => image.previewDataUrl));
    if (attachmentPreview) retained.add(attachmentPreview.previewDataUrl);
    for (const url of attachmentUrls.current) if (!retained.has(url)) { URL.revokeObjectURL(url); attachmentUrls.current.delete(url); }
  }, [images, attachmentPreview]);
  const attachmentQueue = useRef(Promise.resolve());
  const promptCaret = useRef<number | null>(null);
  const submitting = useRef(false); const follow = useRef(true);
  const dictationApi = useMemo(() => ({ ...api, startDictation: (input: { language?: string }) => api.startDictation({ ...input, localOnly: true }) }), [api]);
  const dictation = useDictation(dictationApi, text => {
    setPrompt(current => { const next = insertTranscript(current, promptCaret.current, text); promptCaret.current = next.caret; return next.prompt; });
    requestAnimationFrame(() => { composer.current?.focus(); if (promptCaret.current !== null) composer.current?.setSelectionRange(promptCaret.current, promptCaret.current); });
  });
  useEffect(() => { void api.getDictationSettings().then(value => setDictationAvailable(value.model !== "off")); }, [api, settingsVisible]);
  const provider = settings.provider;
  const { codex, claude } = controllers;
  const controller = controllers[provider];
  const { connection, checking, working } = controller;
  const busy = cloudBusy || chat.loading || pending || attaching || [codex, claude].some(controller => ["install", "disconnect"].includes(controller.working)) || dictation.status.state !== "idle" || !!workspace && workspace.state !== "idle";
  const running = !!workspace && workspace.state !== "idle";
  const selection = settings.providers[provider].orchestrator;
  const selectionError = connection?.state === "ready" ? modelChoiceError(selection, connection.models) : undefined;
  useEffect(() => { if (selectionError) setError(selectionError); }, [selectionError]);
  const reportedError = useRef("");
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const entry = [...(workspace?.entries || [])].reverse().find(entry => entry.kind === "error");
    if (entry && entry.id !== reportedError.current && Date.parse(entry.at) >= mountedAt.current) { reportedError.current = entry.id; setError(entry.text); }
  }, [workspace?.entries]);
  const selectedIds = workspace?.repositoryIds ?? (workspace ? projects.filter(project => (workspace.paths || [workspace.path]).includes(project.rootPath)).map(project => project.id) : settings.workspaceRepositoryIds || []);
  const input = { provider, key: workspace?.key };
  const repositories = projects.filter(project => selectedIds.includes(project.id)).sort((a, b) => a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0);
  const gitRepositories = repositories.filter(project => project.kind === "git");
  const reviewRepository = gitRepositories.find(project => project.id === reviewRoot) || gitRepositories[0];
  const ready = !!workspace && connection?.state === "ready" && !selectionError;
  const hasDraft = !!prompt.trim() || images.length > 0 || feedback.length > 0;

  useEffect(() => { if (active) void api.listProjects().then(setProjects).catch(cause => setError(message(cause))); }, [api, active]);
  useEffect(() => { void api.getStartupSettings().then(value => setSendOnEnter(value.sendOnEnter)).catch(() => undefined); }, [api, settingsVisible]);
  useEffect(() => { setReviewOpen(false); follow.current = true; }, [workspace?.key]);
  useEffect(() => {
    onActivity(chat.chats.some(row => row.state === "waiting") ? "waiting" : chat.chats.some(row => row.state === "running") ? "running" : "idle");
  }, [chat.chats, onActivity]);
  useLayoutEffect(() => { const element = scroller.current; if (element && follow.current) element.scrollTop = element.scrollHeight; }, [workspace?.entries]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight; });
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [workspace?.key, !!workspace?.entries.length]);
  useEffect(() => {
    if (!reviewOpen || !reviewRepository) return;
    let cancelled = false;
    const root = reviewRepository.rootPath;
    const cached = reviewCache.current.get(root);
    setReviewFiles(cached || []); setReviewLoading(!cached); setReviewError("");
    void api.refreshWorkspaceReview({ repositoryPath: root }).then(result => {
      if (cancelled) return;
      reviewCache.current.set(root, result.reviewFiles); setReviewFiles(result.reviewFiles);
    }).catch(cause => { if (!cancelled) setReviewError(message(cause)); }).finally(() => { if (!cancelled) setReviewLoading(false); });
    return () => { cancelled = true; };
  }, [reviewOpen, reviewRepository?.rootPath, running]);

  async function action(fn: () => Promise<unknown>) { setError(""); setPending(true); try { await fn(); } catch (cause) { setError(message(cause)); } finally { setPending(false); } }
  async function submit() {
    if (!hasDraft || busy || !ready || submitting.current) return;
    submitting.current = true;
    const text = prompt; const attached = images; const comments = feedback;
    follow.current = true;
    await action(async () => {
      const next = await api.startCloudTurn({ ...input, prompt: appendReviewFeedback(composerPromptForSend(text), comments), imageIds: attached.map(image => image.id) });
      setWorkspace(next); setPrompt(current => current === text ? "" : current);
      setImages(current => current.filter(image => !attached.includes(image))); setFeedback(current => current.filter(comment => !comments.includes(comment)));
    });
    submitting.current = false; composer.current?.focus();
  }
  async function chooseFolders(extend = true) {
    await action(async () => {
      const result = await api.pickCloudFolders();
      if (!result.length) return;
      setProjects(await api.listProjects());
      await chat.open({ provider, repositoryIds: [...new Set([...(extend ? selectedIds : []), ...result.map(project => project.id)])] }, true, extend);
    });
  }
  function attach(files: File[]) {
    if (!files.length) return;
    setError("");
    if (imagesRef.current.length + files.length > 20) { setError("Attach up to 20 files per message."); return; }
    if (files.some(file => file.size > 20 * 1024 * 1024)) { setError("Each file must be smaller than 20 MB."); return; }
    const pending = files.map(file => ({ id: crypto.randomUUID(), name: file.name || "Pasted image", mimeType: file.type, pending: true,
      previewDataUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" }));
    pending.forEach(image => { if (image.previewDataUrl) attachmentUrls.current.add(image.previewDataUrl); });
    imagesRef.current = [...imagesRef.current, ...pending]; setImages(imagesRef.current); pendingAttachments.current += files.length; setAttaching(true);
    attachmentQueue.current = attachmentQueue.current.then(async () => {
      try {
        const payload = await Promise.all(files.map(fileToPastedAttachment));
        const added = await api.saveCloudImages({ files: payload.map(file => ({ ...file, name: file.name || "Pasted image.png" })) });
        setImages(current => current.flatMap(image => { const index = pending.findIndex(item => item.id === image.id); return index < 0 ? [image] : [{ ...added[index], previewDataUrl: pending[index].previewDataUrl || added[index].previewDataUrl }]; }));
      } catch (cause) { setImages(current => current.filter(image => !pending.some(item => item.id === image.id))); setError(message(cause)); pending.forEach(image => { if (image.previewDataUrl) URL.revokeObjectURL(image.previewDataUrl); }); }
    }).finally(() => { pendingAttachments.current -= files.length; setAttaching(pendingAttachments.current > 0); });
  }
  function openReviewFile(path: string) {
    const project = gitRepositories.find(project => path.startsWith(`${project.rootPath}/`));
    if (project) setReviewRoot(project.id);
    setReviewPath(project ? path.slice(project.rootPath.length + 1) : path); setReviewOpen(true);
  }
  function insert(value: { value: string; caret: number }) { setPrompt(value.value); requestAnimationFrame(() => composer.current?.setSelectionRange(value.caret, value.caret)); }

  function openSettings(tab?: "connection" | "voice" | "keyboard") {
    onOpenSettings(tab === "voice" ? "voice" : tab === "keyboard" ? "keyboard" : "providers");
  }
  useCloudShortcuts({
    "chat.new": () => { if (!chat.loading && !pending && !attaching && dictation.status.state === "idle") void chat.open({ provider, repositoryIds: selectedIds }, true); },
    "chat.delete": () => { const row = chat.chats.find(row => row.key === workspace?.key); if (row && !busy) setDeleteChat([row]); },
    "app.settings": () => openSettings(),
    "app.shortcuts": () => openSettings("keyboard"),
    "composer.focus": () => composer.current?.focus(),
    "review.toggle": () => { if (gitRepositories.length) setReviewOpen(current => !current); },
    "dictation.toggle": () => { if (!running && !pending) { if (dictationAvailable) void dictation.toggle(); else openSettings("voice"); } },
    "run.stop": () => { if (running && !pending && workspace) void action(() => api.stopCloudTurn({ key: workspace.key })); },
  }, !active || !!deleteChat || settingsVisible || resetOpen || feedbackOpen || !!attachmentPreview || !!filePreview, () => setReviewOpen(false));

  return <div className={`cloudShell unifiedCloudShell ${/Mac/.test(navigator.platform) ? "macChrome" : ""}`}>
    <aside className="sidebar">
      {navigation}
      <div className="sidebarStack"><CloudChatArchive chats={chat.chats} projects={projects} activeKey={workspace?.key} loading={chat.loading}
        disabled={pending || attaching || chat.loading || dictation.status.state !== "idle"}
        onSelect={key => void chat.open({ provider, key })} onNew={ids => void chat.open({ provider, repositoryIds: ids || selectedIds }, true)}
        onAddFolder={() => void chooseFolders(false)} onDelete={setDeleteChat}/></div>
      <div className="sidebarFooter">
        <ShortcutTooltip id="app.settings"><button className="settingsPlaceholder" onClick={() => openSettings()}><Settings2 size={16}/><span>Settings</span></button></ShortcutTooltip>
      </div>
    </aside>
    <header className="cloudTopbar">
      <div className="workspaceHeaderIdentity"><strong>{chat.chats.find(row => row.key === workspace?.key)?.title || "New chat"}</strong><small>{repositories.map(project => project.name).join(" · ") || "No folder selected"}</small></div>
      {repositories.some(project => indexingPaths.has(project.rootPath)) && <span className="workspaceIndexing" role="status"><span className="workspaceIndexingSpinner" aria-hidden="true"/>Indexing workspace…</span>}
      <div className="cloudTopbarSpacer"/>
      {gitRepositories.length > 0 && <ShortcutTooltip id="review.toggle" label={reviewOpen ? "Hide review" : "Open review"} placement="bottom"><button className="cloudIconButton" aria-label={reviewOpen ? "Hide review" : "Open review"} aria-pressed={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}><PanelRight size={18}/></button></ShortcutTooltip>}
    </header>
    <main className={`cloudMain ${reviewOpen ? "withReview" : ""}`}>
      <div className={`cloudWorkColumn ${!workspace?.entries.length ? "isEmpty" : ""}`}>
        <div className="cloudCanvas" ref={scroller} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
          {!workspace?.entries.length ? <ComposerGreeting label="What are we working on?"/> : <CloudTimeline workspace={workspace} onLocalFile={(path, line) => setFilePreview({ path, line })} onReviewFile={openReviewFile}/>}
          {workspace?.approvals.map(approval => <CloudApprovalCard key={approval.id} approval={approval} onRespond={(allow, answers) => api.respondCloudApproval({ key: workspace.key, id: approval.id, allow, answers })}/>)}
        </div>
        <div className="cloudDockArea">
          <form className="cloudDock promptInputShell" onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); } }}>
            <div className="promptAttachmentStrip"><AttachmentPreviewList files={images.map(cloudImageAttachment)} mode="composer" onOpen={file => setAttachmentPreview(images.find(image => `${image.id}${image.extension || ".png"}` === file.path))} onRemove={file => setImages(current => current.filter(image => `${image.id}${image.extension || ".png"}` !== file.path))}/>{feedback.length > 0 && <ReviewFeedbackChip count={feedback.length} onClick={() => setFeedbackOpen(true)}/>}</div>
            <div className="promptEditor"><PromptTextarea disabled={chat.loading} dictation={dictation.status} previewCaret={promptCaret.current} ref={composer} aria-label="Give an instruction" placeholder="What should we build today?" value={prompt} maxLength={100_000} onSelect={event => { promptCaret.current = event.currentTarget.selectionStart; }} onChange={event => setPrompt(event.target.value)} onPaste={event => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) { event.preventDefault(); void attach(files); return; }
              const text = event.clipboardData.getData("text/plain");
              if (text) { event.preventDefault(); insert(insertPastedComposerText(prompt, text, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)); }
            }} onKeyDown={event => {
              const result = promptEnterAction({ key: event.key, isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, sendOnEnter, value: prompt, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
              if (!result) return; event.preventDefault();
              if (result.type === "send") void submit(); else insert(result.insertion);
            }}/>
            </div>
            <ComposerActionRail leading={<>
              <DictationControl status={dictation.status} enabled={dictationAvailable} devices={dictation.devices} deviceId={dictation.deviceId} onToggle={dictation.toggle} onSelectDevice={dictation.selectDevice} onRequestSetup={() => openSettings("voice")}/>
              <CloudRunControls settings={settings} connection={connection} disabled={busy} onSave={value => void action(() => onSettings(value))}/>
            </>} trailing={<>
              <CloudModelPicker key={provider} compact label="Model" value={selection} models={connection?.models || []} disabled={busy} onChange={orchestrator => void action(() => onSettings({ ...settings, providers: { ...settings.providers, [provider]: { ...settings.providers[provider], orchestrator, serviceTier: connection?.models.find(model => model.id === orchestrator.model)?.serviceTiers?.some(tier => tier.id === settings.providers[provider].serviceTier) ? settings.providers[provider].serviceTier : "default" } } }))}/>
              {connection?.state !== "ready" && !running ? <button type="button" className="cloudAction cloudConnectAction" disabled={busy || checking && working !== "connect"} onClick={() => {
                if (working === "connect") void controller.cancel(); else openSettings();
              }}>{working === "connect" ? "Cancel" : checking ? "Connecting…" : connection?.state === "missing" ? "Install" : "Connect"}</button> : running ? <ShortcutTooltip id="run.stop" label="Stop work"><button type="button" className="sendButton" aria-label="Stop work" disabled={pending} onClick={() => void action(() => api.stopCloudTurn({ key: workspace!.key }))}><Square size={16}/></button></ShortcutTooltip>
                : <ShortcutTooltip id="composer.send" label="Send prompt" sendOnEnter={sendOnEnter}><button className="sendButton" type="submit" aria-label="Send prompt" disabled={busy || !hasDraft || !ready}><Send size={17}/></button></ShortcutTooltip>}
            </>}/>
          </form>
          <div className="promptControls cloudContextBar">
            <CloudFolders projects={projects} selectedIds={selectedIds} disabled={busy || !!workspace?.entries.length} onChange={ids => void chat.open({ provider, repositoryIds: ids }, true, true)} onAdd={() => void chooseFolders()}/>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.h,.cpp,.sql,.log" multiple hidden onChange={event => { void attach(Array.from(event.target.files || [])); event.target.value = ""; }}/>
            <button className="attachmentTrigger" type="button" aria-label="Attach files" title="Attach files" disabled={chat.loading || attaching} onClick={() => fileInput.current?.click()}><Paperclip size={14}/></button>
            <span className="cloudComposerStatus" role="status">{workspace?.state === "waiting" ? "Waiting for you" : working === "connect" ? "Connecting…" : cloudBusy && !running ? "Another chat is working" : ""}</span>
            <div className="cloudContextMetrics">
            {connection?.state === "ready" && <CloudUsageIndicator workspace={workspace} usage={latestCloudUsage([connection.usage, workspace?.account === connection.account ? workspace?.usage : undefined])}/>}
            {!!workspace?.entries.length && <button type="button" className="cloudResetButton" disabled={busy} onClick={() => setResetOpen(true)} title="Reset context" aria-label="Reset context"><RotateCcw size={15} strokeWidth={1.8} aria-hidden="true"/></button>}
            </div>
          </div>
        </div>
      </div>
      {reviewOpen && <aside className="cloudReview" aria-busy={reviewLoading}>
        {gitRepositories.length > 1 && <div className="cloudReviewFolders"><CloudSelect label="Review folder" value={reviewRepository?.id || ""} onValueChange={setReviewRoot}>{gitRepositories.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</CloudSelect></div>}
        {reviewError ? <p className="cloudReviewLoading" role="alert">{reviewError}</p> : reviewLoading ? <div className="cloudReviewLoading" role="status">Loading changes…</div> : <ReviewPanel key={reviewRepository?.id} files={reviewFiles} open chrome={false} initialSelectedPath={reviewPath} taskId="" scope="worktree" canUseWorktreeScope={false} canOpenIde={false} canUndoFile={false}
          undoUnavailableReason="" selectedIdeLabel="Editor" onClose={() => setReviewOpen(false)} onUndoFile={() => undefined} onUndoAll={() => undefined} onOpenFile={() => undefined} onScopeChange={() => undefined} onResizePointerDown={() => undefined} onResizeKeyDown={() => undefined}
          onAddFeedback={comments => { setFeedback(current => [...current, ...comments.map(comment => ({ ...comment, filePath: gitRepositories.length > 1 ? `${reviewRepository!.rootPath}/${comment.filePath}` : comment.filePath }))]); composer.current?.focus(); }}
          onLoadDocumentReview={async () => ({ ok: false, code: "not_available", message: "Open this document in its native app to preview it." })}/>}</aside>}
    </main>
    {active && deleteChat && <CloudResetDialog deleting count={deleteChat.length} busy={pending} onCancel={() => setDeleteChat(null)} onReset={() => void action(async () => { await chat.remove(deleteChat.map(chat => chat.key)); setDeleteChat(null); })}/>}
    <ErrorToast message={error || dictation.status.error || null} onDismiss={() => { setError(""); dictation.dismissError(); }}/>
    {active && resetOpen && workspace && <CloudResetDialog busy={pending} onCancel={() => setResetOpen(false)} onReset={() => void action(async () => { setWorkspace(await api.resetCloudContext({ key: workspace.key })); setFeedback([]); setImages([]); setPrompt(""); setResetOpen(false); follow.current = true; composer.current?.focus(); })}/>}
    {active && attachmentPreview && <CloudAttachmentPreview file={attachmentPreview} onClose={() => setAttachmentPreview(undefined)}/>}
    {active && filePreview && workspace && <CloudFilePreview api={api} workspaceKey={workspace.key} {...filePreview} onClose={() => setFilePreview(undefined)}/>}
    {active && feedbackOpen && <ReviewFeedbackDialog comments={feedback.map(comment => ({ ...comment, lineLabel: reviewCommentLineLabel(comment) }))} onClose={() => setFeedbackOpen(false)} onRemove={id => setFeedback(current => current.filter(comment => comment.id !== id))} onRemoveAll={() => setFeedback([])} onOpenFile={openReviewFile}/>}
  </div>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
