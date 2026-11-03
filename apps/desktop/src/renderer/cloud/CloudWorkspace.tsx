import React, { useMemo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Plus, PanelRight, RotateCcw, Square, Settings2 } from "lucide-react";
import type { DesktopApi, RepositoryInfo } from "../../shared/desktopApi";
import { modelChoiceError, type CloudImage, type CloudSettings, type CloudWorkspace as Workspace } from "../../shared/cloud";
import type { ReviewFile } from "../../shared/reviewDiff";
import { ReviewPanel } from "../review/ReviewPanel";
import { ReviewFeedbackChip, ReviewFeedbackDialog } from "../review/ReviewFeedbackDialog";
import { appendReviewFeedback, reviewCommentLineLabel, type ReviewCommentDraft } from "../review/reviewComments";
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
import { CloudSettingsPanel } from "./CloudSettingsPanel";
import { CloudApprovalCard } from "./CloudApprovalCard";
import { cloudProviderIcons } from "./CloudProviderIcon";
import { CloudSelect } from "./CloudSelect";
import { CloudFolders } from "./CloudFolders";
import { CloudTimeline, cloudImageAttachment } from "./CloudTimeline";
import { CloudUsageIndicator } from "./CloudUsage";
import { useCloudConnection } from "./useCloudConnection";

export function CloudWorkspace({ api, settings, onSettings }: {
  api: DesktopApi; settings: CloudSettings; onSettings(settings: CloudSettings): Promise<void>;
}) {
  const [projects, setProjects] = useState<RepositoryInfo[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [filePreview, setFilePreview] = useState<{ path: string; line?: number }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [prompt, setPrompt] = useState(""); const [error, setError] = useState("");
  const [attachmentPreview, setAttachmentPreview] = useState<CloudImage>();
  const [voiceSettings, setVoiceSettings] = useState(false);
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const [images, setImages] = useState<CloudImage[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [feedback, setFeedback] = useState<ReviewCommentDraft[]>([]);
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
    const retained = new Set(images.map(image => image.previewDataUrl));
    if (attachmentPreview) retained.add(attachmentPreview.previewDataUrl);
    for (const url of attachmentUrls.current) if (!retained.has(url)) { URL.revokeObjectURL(url); attachmentUrls.current.delete(url); }
  }, [images, attachmentPreview]);
  const attachmentQueue = useRef(Promise.resolve());
  const submitting = useRef(false); const follow = useRef(true); const activeKey = useRef("");
  const dictationApi = useMemo(() => ({ ...api, startDictation: (input: { language?: string }) => api.startDictation({ ...input, localOnly: true }) }), [api]);
  const dictation = useDictation(dictationApi, text => { setPrompt(current => insertTranscript(current, composer.current?.selectionStart ?? null, text).prompt); composer.current?.focus(); });
  useEffect(() => { void api.getDictationSettings().then(value => setDictationAvailable(value.model !== "off")); }, [api, settingsOpen]);
  const provider = settings.provider;
  const controller = useCloudConnection(api, provider, settings.providers[provider].executable);
  const { connection, checking, working } = controller;
  const busy = pending || attaching || working === "install" || dictation.status.state !== "idle" || !!workspace && workspace.state !== "idle";
  const running = !!workspace && workspace.state !== "idle";
  const selection = settings.providers[provider].orchestrator;
  const selectionError = connection?.state === "ready" ? modelChoiceError(selection, connection.models) : undefined;
  const selectedIds = settings.workspaceRepositoryIds || [];
  const folderKey = selectedIds.join("\0");
  const input = { provider, repositoryIds: selectedIds };
  const repositories = projects.filter(project => selectedIds.includes(project.id)).sort((a, b) => a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0);
  const gitRepositories = repositories.filter(project => project.kind === "git");
  const reviewRepository = gitRepositories.find(project => project.id === reviewRoot) || gitRepositories[0];
  const ready = !!workspace && connection?.state === "ready" && !selectionError;
  const hasDraft = !!prompt.trim() || images.length > 0 || feedback.length > 0;

  useEffect(() => { void api.listProjects().then(setProjects).catch(cause => setError(message(cause))); }, [api]);
  useEffect(() => { void api.getStartupSettings().then(value => setSendOnEnter(value.sendOnEnter)).catch(() => undefined); }, [api, settingsOpen]);
  useEffect(() => {
    let cancelled = false; activeKey.current = ""; setWorkspace(null); setReviewOpen(false); setFeedback([]); follow.current = true;
    const unsubscribe = api.onCloudWorkspace(next => { if (next.key === activeKey.current) setWorkspace(next); });
    void api.getCloudWorkspace(input).then(next => { if (!cancelled) { activeKey.current = next.key; setWorkspace(next); } }).catch(cause => { if (!cancelled) setError(message(cause)); });
    return () => { cancelled = true; unsubscribe(); };
  }, [provider, folderKey]);
  useLayoutEffect(() => { const element = scroller.current; if (element && follow.current) element.scrollTop = element.scrollHeight; }, [workspace?.entries]);
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
  async function chooseFolders() {
    await action(async () => {
      const result = await api.pickCloudFolders();
      if (!result.length) return;
      setProjects(await api.listProjects());
      await onSettings({ ...settings, workspaceRepositoryIds: [...new Set([...selectedIds, ...result.map(project => project.id)])] });
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

  return <div className={`cloudShell ${/Mac/.test(navigator.platform) ? "macChrome" : ""}`}>
    <header className="cloudTopbar">
      <CloudFolders projects={projects} selectedIds={selectedIds} disabled={busy} onChange={ids => void action(() => onSettings({ ...settings, workspaceRepositoryIds: ids }))} onAdd={() => void chooseFolders()}/>
      <div className="cloudTopbarSpacer"/>
      {gitRepositories.length > 0 && <button className="cloudIconButton" aria-label={reviewOpen ? "Hide review" : "Open review"} title={reviewOpen ? "Hide review" : "Open review"} aria-pressed={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}><PanelRight size={18}/></button>}
    </header>
    <main className={`cloudMain ${reviewOpen ? "withReview" : ""}`}>
      <div className={`cloudWorkColumn ${!workspace?.entries.length ? "isEmpty" : ""}`}>
        <div className="cloudCanvas" ref={scroller} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
          {!workspace?.entries.length ? <section className="cloudWelcome"><h1>What are we working on?</h1></section> : <CloudTimeline workspace={workspace} onLocalFile={(path, line) => setFilePreview({ path, line })} onReviewFile={openReviewFile}/>}
          {workspace?.approvals.map(approval => <CloudApprovalCard key={approval.id} approval={approval} onRespond={(allow, answers) => api.respondCloudApproval({ key: workspace.key, id: approval.id, allow, answers })}/>)}
        </div>
        <div className="cloudDockArea">
          {(error || dictation.status.error || selectionError) && <div className="cloudNotice" role="alert">{error || dictation.status.error || selectionError}<button onClick={() => { setError(""); dictation.dismissError(); if (selectionError) setSettingsOpen(true); }}>{selectionError ? "Settings" : "Dismiss"}</button></div>}
          <form className="cloudDock" onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); } }}>
            {(images.length > 0 || feedback.length > 0) && <div className="cloudAttachmentStrip"><AttachmentPreviewList files={images.map(cloudImageAttachment)} mode="composer" onOpen={file => setAttachmentPreview(images.find(image => `${image.id}${image.extension || ".png"}` === file.path))} onRemove={file => setImages(current => current.filter(image => `${image.id}${image.extension || ".png"}` !== file.path))}/>{feedback.length > 0 && <ReviewFeedbackChip count={feedback.length} onClick={() => setFeedbackOpen(true)}/>}</div>}
            <PromptTextarea ref={composer} aria-label="Give an instruction" placeholder="Ask anything, or give it something to do…" value={prompt} maxLength={100_000} onChange={event => setPrompt(event.target.value)} onPaste={event => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) { event.preventDefault(); void attach(files); return; }
              const text = event.clipboardData.getData("text/plain");
              if (text) { event.preventDefault(); insert(insertPastedComposerText(prompt, text, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)); }
            }} onKeyDown={event => {
              const result = promptEnterAction({ key: event.key, isComposing: event.nativeEvent.isComposing, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, sendOnEnter, value: prompt, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
              if (!result) return; event.preventDefault();
              if (result.type === "send") void submit(); else insert(result.insertion);
            }}/>
            <div className="cloudDockControls">
              <CloudSelect className="cloudProviderPicker" label="Cloud provider" icons={cloudProviderIcons} value={provider} disabled={busy} onValueChange={value => void action(() => onSettings({ ...settings, provider: value as "codex" | "claude" }))}><option value="codex">ChatGPT</option><option value="claude">Claude Code</option></CloudSelect>
              <CloudModelPicker label="Main orchestrator" value={selection} models={connection?.models || []} disabled={busy} onChange={orchestrator => void action(() => onSettings({ ...settings, providers: { ...settings.providers, [provider]: { ...settings.providers[provider], orchestrator, serviceTier: connection?.models.find(model => model.id === orchestrator.model)?.serviceTiers?.some(tier => tier.id === settings.providers[provider].serviceTier) ? settings.providers[provider].serviceTier : "default" } } }))}/>
              <div className="cloudTopbarSpacer"/>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.h,.cpp,.sql,.log" multiple hidden onChange={event => { void attach(Array.from(event.target.files || [])); event.target.value = ""; }}/>
              <button className="cloudIconButton cloudAttach" type="button" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}><Plus size={20}/></button>
              <DictationControl status={dictation.status} enabled={dictationAvailable} devices={dictation.devices} deviceId={dictation.deviceId} onToggle={dictation.toggle} onSelectDevice={dictation.selectDevice} onRequestSetup={() => { setVoiceSettings(true); setSettingsOpen(true); }}/>
              {connection?.state !== "ready" && !running ? <button type="button" className="cloudAction cloudConnectAction" disabled={busy || checking && working !== "connect"} onClick={() => {
                if (working === "connect") void controller.cancel(); else setSettingsOpen(true);
              }}>{working === "connect" ? "Cancel" : checking ? "Connecting…" : connection?.state === "missing" ? "Install" : "Connect"}</button> : running ? <button type="button" className="cloudSend" aria-label="Stop work" disabled={pending} onClick={() => void action(() => api.stopCloudTurn({ key: workspace!.key }))}><Square size={16}/></button>
                : <button className="cloudSend" type="submit" aria-label="Start work" disabled={busy || !hasDraft || !ready}><ArrowUp size={20}/></button>}
            </div>
          </form>
          <div className="cloudContextBar"><CloudRunControls settings={settings} connection={connection} disabled={busy} onSave={value => void action(() => onSettings(value))}/><span role="status">{workspace?.state === "waiting" ? "Waiting for you" : working === "connect" ? "Connecting…" : ""}</span>
            {connection?.state === "ready" && <CloudUsageIndicator workspace={workspace} usage={latestCloudUsage([connection.usage, workspace?.account === connection.account ? workspace?.usage : undefined])}/>}
            {!!workspace?.entries.length && <button disabled={busy} onClick={() => setResetOpen(true)} title="Reset context"><RotateCcw size={13}/><span>Reset context</span></button>}
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
    <button className="cloudSettingsLauncher cloudIconButton" title="Settings" aria-label="Cloud settings" disabled={busy} onClick={() => setSettingsOpen(true)}><span className="topbarLogo" aria-hidden="true"/><span>Umbratic</span><Settings2 size={14} aria-hidden="true"/></button>
    {settingsOpen && <CloudSettingsPanel usage={latestCloudUsage([connection?.usage, workspace?.account === connection?.account ? workspace?.usage : undefined])} api={api} initialTab={voiceSettings ? "voice" : "connection"} settings={settings} controller={controller} onSave={onSettings} onClose={() => { setSettingsOpen(false); setVoiceSettings(false); }}/>}
    {resetOpen && workspace && <CloudResetDialog busy={pending} onCancel={() => setResetOpen(false)} onReset={() => void action(async () => { setWorkspace(await api.resetCloudContext({ key: workspace.key })); setFeedback([]); setImages([]); setPrompt(""); setResetOpen(false); follow.current = true; composer.current?.focus(); })}/>}
    {attachmentPreview && <CloudAttachmentPreview file={attachmentPreview} onClose={() => setAttachmentPreview(undefined)}/>}
    {filePreview && workspace && <CloudFilePreview api={api} workspaceKey={workspace.key} {...filePreview} onClose={() => setFilePreview(undefined)}/>}
    {feedbackOpen && <ReviewFeedbackDialog comments={feedback.map(comment => ({ ...comment, lineLabel: reviewCommentLineLabel(comment) }))} onClose={() => setFeedbackOpen(false)} onRemove={id => setFeedback(current => current.filter(comment => comment.id !== id))} onRemoveAll={() => setFeedback([])} onOpenFile={openReviewFile}/>}
  </div>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
