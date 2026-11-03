import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, PanelRight, RotateCcw, Settings2, Square } from "lucide-react";
import type { DesktopApi, RepositoryInfo } from "../../shared/desktopApi";
import type { CloudSettings, CloudWorkspace as Workspace } from "../../shared/cloud";
import { modelChoiceError } from "../../shared/cloud";
import type { ReviewFile } from "../../shared/reviewDiff";
import { MarkdownContent } from "../markdownContent";
import { ReviewPanel } from "../review/ReviewPanel";
import { CloudModelPicker } from "./CloudModelPicker";
import { CloudSettingsPanel } from "./CloudSettingsPanel";
import { CloudApprovalCard } from "./CloudApprovalCard";
import { cloudProviderIcons } from "./CloudProviderIcon";
import { CloudSelect } from "./CloudSelect";
import { useCloudConnection } from "./useCloudConnection";

export function CloudWorkspace({ api, settings, onSettings }: {
  api: DesktopApi; settings: CloudSettings; onSettings(settings: CloudSettings): Promise<void>;
}) {
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [projects, setProjects] = useState<RepositoryInfo[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState(""); const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null);
  const activeKey = useRef("");
  const provider = settings.provider;
  const controller = useCloudConnection(api, provider, settings.providers[provider].executable);
  const { connection, checking, working } = controller;
  const busy = pending || working === "install" || !!workspace && workspace.state !== "idle";
  const running = !!workspace && workspace.state !== "idle";
  const selection = settings.providers[provider].orchestrator;
  const selectionError = connection?.state === "ready" ? modelChoiceError(selection, connection.models) : undefined;
  const input = { provider, ...(repository ? { repositoryId: repository.id } : {}) };

  useEffect(() => { void api.listProjects().then(setProjects).catch(cause => setError(message(cause))); }, [api]);
  useEffect(() => {
    let cancelled = false; activeKey.current = ""; setWorkspace(null); setReviewFiles(null);
    const unsubscribe = api.onCloudWorkspace(next => { if (next.key === activeKey.current) setWorkspace(next); });
    void api.getCloudWorkspace(input).then(next => { if (!cancelled) { activeKey.current = next.key; setWorkspace(next); } }).catch(cause => { if (!cancelled) setError(message(cause)); });
    return () => { cancelled = true; unsubscribe(); };
  }, [provider, repository?.id]);
  useEffect(() => {
    const element = scroller.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 250) element.scrollTop = element.scrollHeight;
  }, [workspace?.entries]);

  async function action(fn: () => Promise<unknown>) { setError(""); setPending(true); try { await fn(); } catch (cause) { setError(message(cause)); } finally { setPending(false); } }
  async function submit() {
    if (!prompt.trim() || busy || !workspace) return;
    const text = prompt;
    await action(async () => { const next = await api.startCloudTurn({ ...input, prompt: text }); setWorkspace(next); setPrompt(""); });
  }
  async function chooseFolder() {
    await action(async () => { const result = await api.pickRepository(); if (!result.canceled) { setRepository(result.repository); setProjects(await api.listProjects()); } });
  }
  async function saveSettings(value: CloudSettings) { await onSettings(value); }
  const output = workspace?.entries.filter(entry => settings.showToolActivity || entry.kind !== "activity") || [];

  return <div className={`cloudShell ${/Mac/.test(navigator.platform) ? "macChrome" : ""}`}>
    <header className="cloudTopbar">
      <span className="cloudBrand"><span className="topbarLogo"/>Umbratic</span>
      <div className="cloudTopbarSpacer"/>
      <div className="cloudFolderPicker"><FolderOpen size={15}/><CloudSelect label="Workspace" value={repository?.id || "scratch"} disabled={busy} onValueChange={selectedValue => {
        if (selectedValue === "new") { void chooseFolder(); return; }
        setRepository(projects.find(project => project.id === selectedValue) || null);
      }}><option value="scratch">Workspace</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}<option value="new">Open folder…</option></CloudSelect></div>
      <div className="cloudTopbarSpacer"/>
      <div className="cloudWorkspaceActions">
        {repository?.kind === "git" && <button aria-label="Changes" title="Changes" aria-pressed={!!reviewFiles} disabled={pending} onClick={() => reviewFiles ? setReviewFiles(null) : void action(async () => { setReviewFiles((await api.refreshWorkspaceReview({ repositoryPath: repository.rootPath })).reviewFiles); })}><PanelRight size={17}/></button>}
      </div>
      <button className="cloudIconButton" title="Cloud settings" aria-label="Cloud settings" disabled={busy} onClick={() => setSettingsOpen(true)}><Settings2 size={19}/></button>
    </header>
    <main className={`cloudMain ${reviewFiles ? "withReview" : ""}`}>
      <div className={`cloudWorkColumn ${!output.length ? "isEmpty" : ""}`}>
        <div className="cloudCanvas" ref={scroller}>
          {!output.length ? <section className="cloudWelcome"><h1>What are we working on?</h1></section> : <div className="cloudWorkStream">{output.map(entry => <article className={`cloudEntry cloudEntry-${entry.kind}`} key={entry.id}>
            {entry.kind === "answer" ? <MarkdownContent content={entry.text} streaming={false}/> : <p>{entry.text}</p>}
          </article>)}</div>}
          {workspace?.approvals.map(approval => <CloudApprovalCard key={approval.id} approval={approval} onRespond={(allow, answers) => api.respondCloudApproval({ key: workspace.key, id: approval.id, allow, answers })}/>)}
        </div>
        <div className="cloudDockArea">
          {(error || selectionError) && <div className="cloudNotice" role="alert">{error || selectionError}<button onClick={() => { setError(""); if (selectionError) setSettingsOpen(true); }}>{selectionError ? "Settings" : "Dismiss"}</button></div>}
          <form className="cloudDock" onSubmit={event => { event.preventDefault(); void submit(); }}>
            <textarea ref={composer} aria-label="Give an instruction" placeholder="Ask anything, or give it something to do…" value={prompt} maxLength={100_000} rows={2} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
            }}/>
            <div className="cloudDockControls">
              <CloudSelect className="cloudProviderPicker" label="Cloud provider" icons={cloudProviderIcons} value={provider} disabled={busy} onValueChange={selectedValue => void action(() => onSettings({ ...settings, provider: selectedValue as "codex" | "claude" }))}><option value="codex">ChatGPT</option><option value="claude">Claude Code</option></CloudSelect>
              <CloudModelPicker label="Main orchestrator" value={selection} models={connection?.models || []} disabled={busy} onChange={orchestrator => void action(() => onSettings({ ...settings, providers: { ...settings.providers, [provider]: { ...settings.providers[provider], orchestrator } } }))}/>
              <div className="cloudTopbarSpacer"/>
              {connection?.state !== "ready" && !running ? <button type="button" className="cloudAction cloudConnectAction" disabled={busy || checking && working !== "connect"} onClick={() => {
                if (working === "connect") void controller.cancel(); else setSettingsOpen(true);
              }}>{working === "connect" ? "Cancel connection" : checking ? "Connecting…" : connection?.state === "missing" ? `Install ${provider === "codex" ? "Codex" : "Claude Code"}` : `Connect ${provider === "codex" ? "Codex" : "Claude Code"}`}</button> : running ? <button type="button" className="cloudSend" aria-label="Stop work" disabled={pending || !workspace} onClick={() => void action(() => api.stopCloudTurn({ key: workspace!.key }))}><Square size={16}/></button>
                : <button className="cloudSend" type="submit" aria-label="Start work" disabled={busy || !prompt.trim() || !workspace || connection?.state !== "ready" || !!selectionError}><ArrowUp size={20}/></button>}
            </div>
          </form>
          <div className="cloudContextBar"><span role="status">{workspace?.state === "waiting" ? "Waiting for you" : running ? "Working…" : working === "install" ? "Installing…" : working === "connect" ? "Connecting…" : checking ? "Connecting…" : ""}</span>
            {workspace?.sessionId && <button disabled={busy} onClick={() => void action(async () => { setWorkspace(await api.resetCloudContext({ key: workspace.key })); })} title="Reset context; keep files"><RotateCcw size={13}/> Reset context</button>}
          </div>
        </div>
      </div>
      {reviewFiles && <aside className="cloudReview"><ReviewPanel files={reviewFiles} open taskId="" scope="worktree" canUseWorktreeScope={false} canOpenIde={false} canUndoFile={false}
        undoUnavailableReason="Cloud changes are managed in your workspace." selectedIdeLabel="Editor" onClose={() => setReviewFiles(null)} onUndoFile={() => undefined} onUndoAll={() => undefined} onOpenFile={() => undefined} onScopeChange={() => undefined} onResizePointerDown={() => undefined} onResizeKeyDown={() => undefined}
        onAddFeedback={comments => { setPrompt(comments.map(comment => JSON.stringify(comment)).join("\n")); composer.current?.focus(); }}
        onLoadDocumentReview={async () => ({ ok: false, code: "not_available", message: "Open this document in its native app to preview it." })}/></aside>}
    </main>
    {settingsOpen && <CloudSettingsPanel settings={settings} controller={controller} onSave={saveSettings} onClose={() => setSettingsOpen(false)}/>}
  </div>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
