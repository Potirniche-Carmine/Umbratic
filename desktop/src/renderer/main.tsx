import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  GitBranch,
  GitFork,
  PanelLeft,
  Plus,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import "./styles.css";

type ServiceStatus = "ready" | "degraded" | "unavailable";
type SocketState = "idle" | "connecting" | "open" | "closed";
type RailView = "chats" | "git";
type MainTab = "chat" | "diff" | "data";
type PermissionMode = "default" | "bypass";

type DaemonHealth = {
  daemon: ServiceStatus;
  sqlite_path: string;
  lm_studio: ServiceStatus;
  model_base_url: string;
  semantic_index: ServiceStatus;
};

type RpcResponse<T> = {
  id: string;
  result?: T;
  error?: { message: string };
};

type ServerEvent =
  | {
      type: "status";
      daemon: ServiceStatus;
      sqlite_path: string;
      lm_studio: ServiceStatus;
      model_base_url: string;
      semantic_index: ServiceStatus;
    }
  | { type: "trace"; at: string; level: string; message: string; data?: unknown }
  | { type: "agent_stream"; turn_id: string; kind: string; content?: string; data?: unknown };

type ChatLine = {
  role: "user" | "assistant";
  content: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  root_path: string;
  preferred_ide?: string | null;
  created_at: string;
  last_opened_at?: string | null;
};

type SessionSummary = {
  id: string;
  project_id: string;
  title?: string | null;
  model_id?: string | null;
  started_at: string;
  finished_at?: string | null;
  status: string;
  user_message?: string | null;
};

type StoreOverview = {
  sqlite_path: string;
  projects: number;
  sessions: number;
  turns: number;
  tool_calls: number;
  proposals: number;
  index_chunks: number;
};

type GitResult = {
  stdout: string;
  stderr: string;
  success: boolean;
};

type GitBranchInfo = {
  current?: string | null;
  branches: string[];
};

type GitWorktreeInfo = {
  path: string;
  branch?: string | null;
  commit?: string | null;
};

type SearchMatch = {
  path: string;
  line: number;
  snippet: string;
};

type IdeInstall = {
  id: "code" | "devenv" | "clion" | "explorer" | string;
  label: string;
  command: string;
};

type SendTaskResult = {
  session_id: string;
  turn_id: string;
  assistant_message: string;
};

type TimelineRow = {
  id: string;
  name: string;
  status: ServiceStatus;
  detail: string;
  at: string;
};

type LocalChat = {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatLine[];
  timeline: TimelineRow[];
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  worktreeEnabled: boolean;
  diffAvailable?: boolean;
  changedFileCount?: number;
};

type DesktopConnection =
  | { status: "ready"; url: string; token: string }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

type PickProjectResult =
  | { canceled: true }
  | { canceled: false; rootPath: string; name: string };

type DesktopApi = {
  getDaemonConnection(): Promise<DesktopConnection>;
  restartDaemon(): Promise<DesktopConnection>;
  pickProjectFolder(): Promise<PickProjectResult>;
  onOpenProjectRequested(callback: () => void): () => void;
  onBackToChatRequested(callback: () => void): () => void;
  onToggleSidebarRequested(callback: () => void): () => void;
};

const aegisApi: DesktopApi =
  window.aegis ??
  {
    getDaemonConnection: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    restartDaemon: async () => ({
      status: "missing",
      message: "This is the browser preview. Open the Electron window from npm run desktop:dev.",
    }),
    pickProjectFolder: async () => ({ canceled: true }),
    onOpenProjectRequested: () => () => undefined,
    onBackToChatRequested: () => () => undefined,
    onToggleSidebarRequested: () => () => undefined,
  };

function newLocalChat(branch?: string): LocalChat {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: new Date().toISOString(),
    messages: [],
    timeline: [],
    branch,
    worktreeEnabled: false,
  };
}

function summarizeForSlug(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 3);
  return (words.length > 0 ? words : ["aegis", "task"]).join("-");
}

function cleanPath(path?: string | null): string {
  if (!path) {
    return "";
  }
  return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "\\");
}

function diffFileCount(diff?: GitResult | null): number {
  if (!diff?.stdout.trim()) {
    return 0;
  }
  return parseDiff(diff.stdout).length;
}

function App() {
  const firstChat = useMemo(() => newLocalChat(), []);
  const [connection, setConnection] = useState<DesktopConnection | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("google/gemma-4-e4b");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [storeOverview, setStoreOverview] = useState<StoreOverview | null>(null);
  const [gitStatus, setGitStatus] = useState<GitResult | null>(null);
  const [gitDiff, setGitDiff] = useState<GitResult | null>(null);
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo>({ branches: [] });
  const [selectedBranch, setSelectedBranch] = useState("");
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [activeFile, setActiveFile] = useState<SearchMatch | null>(null);
  const [activeRail, setActiveRail] = useState<RailView>("chats");
  const [activeTab, setActiveTab] = useState<MainTab>("chat");
  const [prompt, setPrompt] = useState("");
  const [chats, setChats] = useState<LocalChat[]>([firstChat]);
  const [activeChatId, setActiveChatId] = useState(firstChat.id);
  const [ides, setIdes] = useState<IdeInstall[]>([]);
  const [selectedIdeId, setSelectedIdeId] = useState("code");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [showBypassConfirm, setShowBypassConfirm] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [leftWidth, setLeftWidth] = useState(286);
  const [rightWidth, setRightWidth] = useState(360);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, (response: RpcResponse<unknown>) => void>());
  const streamingChatRef = useRef<string | null>(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? chats[0];
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const visibleProject = useMemo(
    () => selectedProject ? { ...selectedProject, root_path: cleanPath(selectedProject.root_path) } : null,
    [selectedProject],
  );
  const selectedIde = useMemo(
    () => ides.find((ide) => ide.id === selectedIdeId) ?? ides[0] ?? { id: "code", label: "VS Code", command: "code" },
    [ides, selectedIdeId],
  );

  const telemetry = useMemo(
    () => ({
      connection,
      health,
      selectedProject: visibleProject,
      activeFile,
      chats: chats.length,
      activeChat,
      sessions: sessions.length,
      sessionRows: sessions,
      storeOverview,
      branchInfo,
      worktrees: worktrees.map((worktree) => ({ ...worktree, path: cleanPath(worktree.path) })),
      models,
      selectedModel,
      permissionMode,
      lastError: error,
    }),
    [activeChat, activeFile, branchInfo, chats.length, connection, error, health, models, permissionMode, selectedModel, sessions, storeOverview, visibleProject, worktrees],
  );
  const agentTimeline = useMemo(
    () => activeChat.timeline.filter((row) => ["agent", "reasoning", "tool"].includes(row.name)),
    [activeChat.timeline],
  );

  const updateChat = useCallback((chatId: string, updater: (chat: LocalChat) => LocalChat) => {
    setChats((rows) => rows.map((chat) => (chat.id === chatId ? updater(chat) : chat)));
  }, []);

  const addTimeline = useCallback((name: string, status: ServiceStatus, detail: string, chatId = activeChatId) => {
    const row: TimelineRow = {
      id: crypto.randomUUID(),
      name,
      status,
      detail,
      at: new Date().toLocaleTimeString(),
    };
    updateChat(chatId, (chat) => ({ ...chat, timeline: [row, ...chat.timeline].slice(0, 40) }));
  }, [activeChatId, updateChat]);

  const rpc = useCallback(<T,>(method: string, params: unknown): Promise<T> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Daemon socket is not open."));
    }
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result as T);
        }
      });
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error(`${method} timed out.`));
        }
      }, 45000);
    });
  }, []);

  const refreshStore = useCallback(async () => {
    setStoreOverview(await rpc<StoreOverview>("store.overview", {}));
  }, [rpc]);

  const refreshSessions = useCallback(async (projectId = selectedProjectId) => {
    setSessions(await rpc<SessionSummary[]>("session.list", { projectId }));
  }, [rpc, selectedProjectId]);

  const refreshGit = useCallback(async (project = selectedProject) => {
    if (!project) {
      setGitStatus(null);
      setGitDiff(null);
      setBranchInfo({ branches: [] });
      setWorktrees([]);
      return null;
    }
    const params = { projectRoot: project.root_path };
    const [status, diff, branches, treeRows] = await Promise.all([
      rpc<GitResult>("git.status", params),
      rpc<GitResult>("git.diff", params),
      rpc<GitBranchInfo>("git.branches", params),
      rpc<GitWorktreeInfo[]>("git.worktree_list", params),
    ]);
    setGitStatus(status);
    setGitDiff(diff);
    setBranchInfo(branches);
    setWorktrees(treeRows);
    const nextBranch = branches.current ?? branches.branches[0] ?? "";
    setSelectedBranch((current) => current || nextBranch);
    addTimeline("git", status.success && diff.success ? "ready" : "degraded", "branch, status, diff refreshed");
    return diff;
  }, [addTimeline, rpc, selectedProject]);

  const loadInitialData = useCallback(async () => {
    const [healthResult, projectRows, sessionRows, overview, detectedIdes, modelRows] = await Promise.all([
      rpc<DaemonHealth>("daemon.health", {}),
      rpc<ProjectSummary[]>("project.list", {}),
      rpc<SessionSummary[]>("session.list", {}),
      rpc<StoreOverview>("store.overview", {}),
      rpc<IdeInstall[]>("ide.detect", {}),
      rpc<Array<{ id: string }>>("model.list", {}),
    ]);
    setHealth(healthResult);
    setProjects(projectRows);
    setSessions(sessionRows);
    setStoreOverview(overview);
    setIdes(detectedIdes);
    setModels(modelRows.map((model) => model.id));
    setSelectedModel((current) => modelRows.some((model) => model.id === current) ? current : modelRows[0]?.id ?? current);
    setSelectedIdeId((current) => detectedIdes.some((ide) => ide.id === current) ? current : detectedIdes.find((ide) => ide.id === "code")?.id ?? detectedIdes[0]?.id ?? "code");
    setSelectedProjectId((current) => current ?? projectRows[0]?.id ?? null);
    addTimeline("daemon", "ready", "connected");
    addTimeline("lm-studio", healthResult.lm_studio, `${modelRows.length} model(s)`);
  }, [addTimeline, rpc]);

  const connect = useCallback(async () => {
    setSocketState("connecting");
    setError(null);
    const daemon = await aegisApi.getDaemonConnection();
    setConnection(daemon);

    if (daemon.status !== "ready") {
      setSocketState("closed");
      setError(daemon.message);
      addTimeline("desktop", "unavailable", daemon.message);
      return;
    }

    const ws = new WebSocket(`${daemon.url}?token=${encodeURIComponent(daemon.token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setSocketState("open");
      void loadInitialData().catch((cause) => setError(String(cause)));
    };

    ws.onclose = () => setSocketState("closed");
    ws.onerror = () => setError("WebSocket connection to the daemon failed.");
    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as RpcResponse<unknown> | ServerEvent;
      if ("id" in parsed) {
        const handler = pendingRef.current.get(parsed.id);
        if (handler) {
          pendingRef.current.delete(parsed.id);
          handler(parsed);
        }
        return;
      }
      if (parsed.type === "status") {
        setHealth({
          daemon: parsed.daemon,
          sqlite_path: parsed.sqlite_path,
          lm_studio: parsed.lm_studio,
          model_base_url: parsed.model_base_url,
          semantic_index: parsed.semantic_index,
        });
      }
      if (parsed.type === "agent_stream") {
        const chatId = streamingChatRef.current;
        if (!chatId) {
          return;
        }
        if (parsed.kind === "message.delta" && parsed.content) {
          updateChat(chatId, (chat) => {
            const messages = [...chat.messages];
            const last = messages[messages.length - 1];
            if (last?.role === "assistant") {
              messages[messages.length - 1] = { ...last, content: `${last.content}${parsed.content}` };
            } else {
              messages.push({ role: "assistant", content: parsed.content ?? "" });
            }
            return { ...chat, messages };
          });
        }
        if (parsed.kind === "reasoning.start") {
          addTimeline("reasoning", "degraded", "model reasoning stream active", chatId);
        }
      }
    };
  }, [addTimeline, loadInitialData, updateChat]);

  const pickProject = useCallback(async () => {
    setError(null);
    const picked = await aegisApi.pickProjectFolder();
    if (picked.canceled) {
      return;
    }
    const project = await rpc<ProjectSummary>("project.add", {
      root_path: picked.rootPath,
      name: picked.name,
    });
    setProjects((rows) => [project, ...rows.filter((row) => row.id !== project.id)]);
    setSelectedProjectId(project.id);
    setActiveRail("chats");
    setActiveTab("chat");
    setActiveFile(null);
    addTimeline("project", "ready", project.root_path);
    await Promise.all([refreshSessions(project.id), refreshStore(), refreshGit(project)]);
  }, [addTimeline, refreshGit, refreshSessions, refreshStore, rpc]);

  useEffect(() => {
    void connect();
    const unsubscribeOpen = aegisApi.onOpenProjectRequested(() => void pickProject());
    const unsubscribeBack = aegisApi.onBackToChatRequested(() => setActiveTab("chat"));
    const unsubscribeSidebar = aegisApi.onToggleSidebarRequested(() => setSidebarVisible((visible) => !visible));
    return () => {
      wsRef.current?.close();
      unsubscribeOpen();
      unsubscribeBack();
      unsubscribeSidebar();
    };
    // The connection is intentionally single-shot; project state changes must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (socketState === "open") {
      void refreshSessions(selectedProjectId).catch((cause) => setError(String(cause)));
    }
  }, [refreshSessions, selectedProjectId, socketState]);

  useEffect(() => {
    if (socketState === "open" && selectedProject) {
      void refreshGit(selectedProject).catch((cause) => {
        setGitStatus({ stdout: "", stderr: String(cause), success: false });
        setGitDiff(null);
      });
    }
  }, [selectedProjectId, socketState]);

  const newChat = () => {
    const chat = newLocalChat(selectedBranch);
    setChats((rows) => [chat, ...rows]);
    setActiveChatId(chat.id);
    setPrompt("");
    setActiveTab("chat");
  };

  const deleteChat = (chatId: string) => {
    setChats((rows) => {
      if (rows.length === 1) {
        const replacement = newLocalChat(selectedBranch);
        setActiveChatId(replacement.id);
        return [replacement];
      }
      const nextRows = rows.filter((chat) => chat.id !== chatId);
      if (chatId === activeChatId) {
        setActiveChatId(nextRows[0]?.id ?? firstChat.id);
      }
      return nextRows;
    });
  };

  const restart = async () => {
    setSocketState("connecting");
    setError(null);
    wsRef.current?.close();
    pendingRef.current.clear();
    const daemon = await aegisApi.restartDaemon();
    setConnection(daemon);
    setTimeout(() => void connect(), 150);
  };

  const ensureWorktree = async (chatId: string, message: string): Promise<GitWorktreeInfo | null> => {
    const chat = chats.find((row) => row.id === chatId);
    if (!selectedProject || !chat?.worktreeEnabled || chat.worktreePath) {
      return null;
    }
    const slug = summarizeForSlug(message);
    const branch = selectedBranch || branchInfo.current || "HEAD";
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
    const newBranch = `codex/${slug}-${stamp}`;
    addTimeline("worktree", "degraded", `creating Aegis/${slug}`, chatId);
    const worktree = await rpc<GitWorktreeInfo>("git.worktree_create", {
      projectRoot: selectedProject.root_path,
      branch,
      newBranch,
      worktreeName: slug,
    });
    updateChat(chatId, (row) => ({
      ...row,
      branch: newBranch,
      worktreePath: worktree.path,
    }));
    setSelectedBranch(newBranch);
    setWorktrees((rows) => [worktree, ...rows.filter((row) => row.path !== worktree.path)]);
    addTimeline("worktree", "ready", worktree.path, chatId);
    return worktree;
  };

  const sendTask = async () => {
    const trimmed = prompt.trim();
    const chatId = activeChat.id;
    if (!trimmed || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    setPrompt("");
    streamingChatRef.current = chatId;
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.messages.length === 0 ? trimmed.slice(0, 64) : chat.title,
      branch: selectedBranch,
      messages: [...chat.messages, { role: "user", content: trimmed }],
    }));
    addTimeline("agent", "degraded", "generating response", chatId);
    try {
      const chat = chats.find((row) => row.id === chatId);
      const lazyWorktree = await ensureWorktree(chatId, trimmed);
      const workingRoot = lazyWorktree?.path ?? chat?.worktreePath ?? selectedProject?.root_path;
      const result = await rpc<SendTaskResult>("agent.send_task", {
        project_id: selectedProject?.id,
        project_root: workingRoot,
        message: trimmed,
        model: selectedModel,
        git_branch: lazyWorktree?.branch ?? (selectedBranch || undefined),
        worktree_enabled: chat?.worktreeEnabled ?? false,
        worktree_path: workingRoot,
        permission_mode: permissionMode,
      });
      updateChat(chatId, (row) => ({
        ...row,
        sessionId: result.session_id,
        messages: (() => {
          const messages = [...row.messages];
          const last = messages[messages.length - 1];
          if (last?.role === "assistant") {
            messages[messages.length - 1] = { role: "assistant", content: result.assistant_message || last.content || "(empty response)" };
            return messages;
          }
          return [...messages, { role: "assistant", content: result.assistant_message || "(empty response)" }];
        })(),
      }));
      addTimeline("agent", "ready", `turn ${result.turn_id.slice(0, 8)} finished`, chatId);
      const [, , refreshedDiff] = await Promise.all([refreshSessions(selectedProjectId), refreshStore(), refreshGit(selectedProject ?? undefined)]);
      const changedFileCount = diffFileCount(refreshedDiff);
      if (changedFileCount > 0) {
        updateChat(chatId, (row) => ({
          ...row,
          diffAvailable: true,
          changedFileCount,
        }));
      }
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("agent", "unavailable", message, chatId);
    } finally {
      streamingChatRef.current = null;
      setBusy(false);
    }
  };

  const toggleWorktree = (enabled: boolean) => {
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      worktreeEnabled: enabled,
      worktreePath: enabled ? chat.worktreePath : undefined,
    }));
  };

  const openInIde = async (ideId = selectedIdeId) => {
    if (!selectedProject) {
      return;
    }
    const target = activeFile;
    try {
      if (target) {
        await rpc("ide.open_file", {
          ideId,
          projectRoot: activeChat.worktreePath ?? selectedProject.root_path,
          file: target.path,
          line: target.line,
        });
        addTimeline("ide", "ready", `opened ${target.path}`);
      } else {
        await rpc("ide.open_project", {
          ideId,
          projectRoot: activeChat.worktreePath ?? selectedProject.root_path,
        });
        addTimeline("ide", "ready", `opened ${selectedProject.name}`);
      }
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      addTimeline("ide", "unavailable", message);
    }
  };

  const copyTelemetry = async () => {
    await navigator.clipboard.writeText(JSON.stringify(telemetry, null, 2));
    addTimeline("telemetry", "ready", "copied telemetry JSON");
  };

  const choosePermissionMode = (mode: PermissionMode) => {
    setPermissionMenuOpen(false);
    if (mode === "bypass" && permissionMode !== "bypass") {
      setShowBypassConfirm(true);
      return;
    }
    setPermissionMode(mode);
  };

  const startResize = (side: "left" | "right", event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = side === "left" ? leftWidth : rightWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (side === "left") {
        setLeftWidth(Math.max(230, Math.min(520, initial + delta)));
      } else {
        setRightWidth(Math.max(300, Math.min(640, initial - delta)));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const railTitle = {
    chats: "Chats",
    git: "Git",
  }[activeRail];

  return (
    <main
      className={`app ${sidebarVisible ? "" : "sidebarCollapsed"}`}
      style={{
        gridTemplateColumns: `56px ${sidebarVisible ? leftWidth : 0}px minmax(520px, 1fr) ${rightWidth}px`,
      }}
    >
      <header className="topbar">
        <div className="brand">
          <Code2 size={22} />
          <span>Aegis</span>
        </div>
        <div className="navControls">
          <button className="iconButton" title="Back to chat" onClick={() => setActiveTab("chat")}>
            <ArrowLeft size={17} />
          </button>
          <button className="iconButton" title="Toggle sidebar" onClick={() => setSidebarVisible((visible) => !visible)}>
            <PanelLeft size={17} />
          </button>
        </div>
        <button className="projectButton glassControl" title="Open folder" onClick={pickProject}>
          <FolderOpen size={17} />
          <span>{selectedProject?.name ?? "Open folder"}</span>
        </button>
        <div className="statusPill" data-status={socketState === "open" ? "ready" : "unavailable"}>
          <Activity size={16} />
          <span>{socketState}</span>
        </div>
        <div className="statusPill" data-status={health?.lm_studio ?? "unavailable"}>
          <Bot size={16} />
          <span>LM Studio</span>
        </div>
        <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Model">
          {[selectedModel, ...models.filter((model) => model !== selectedModel)].map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <div className="menuControl">
          <button
            className={`openIdeButton ${selectedIde.id === "code" ? "vscodeButton" : ""}`}
            onClick={() => setIdeMenuOpen((open) => !open)}
            disabled={!selectedProject}
            aria-haspopup="menu"
            aria-expanded={ideMenuOpen}
          >
            <IdeGlyph id={selectedIde.id} />
            <span>{selectedIde.label}</span>
            <ChevronDown size={14} />
          </button>
          {ideMenuOpen ? (
            <div className="menuPopover ideMenu" role="menu">
              {(ides.length > 0 ? ides : [{ id: "code", label: "VS Code", command: "code" }]).map((ide) => (
                <button
                  key={ide.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSelectedIdeId(ide.id);
                    setIdeMenuOpen(false);
                    void openInIde(ide.id);
                  }}
                >
                  <IdeGlyph id={ide.id} />
                  <span>{ide.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button className="iconButton" title="Restart daemon" onClick={restart}>
          <RefreshCw size={17} />
        </button>
      </header>

      <aside className="rail">
        <RailButton active={activeRail === "chats"} title="Chats" onClick={() => setActiveRail("chats")}>
          <Terminal size={19} />
        </RailButton>
        <RailButton active={activeRail === "git"} title="Git status" onClick={() => setActiveRail("git")}>
          <GitBranch size={19} />
        </RailButton>
      </aside>

      {sidebarVisible ? (
      <section className="sidebar">
        <div className="sidebarHeader">
          <h2>{railTitle}</h2>
          {activeRail === "chats" ? (
            <button className="newChatButton" onClick={newChat} title="New chat">
              <Plus size={15} />
            </button>
          ) : null}
        </div>
        {activeRail === "chats" ? (
          <SidebarChats chats={chats} activeChatId={activeChat.id} onSelect={setActiveChatId} onDelete={deleteChat} />
        ) : null}
        {activeRail === "git" ? (
          <SidebarGit
            status={gitStatus}
            diff={gitDiff}
            branchInfo={branchInfo}
            worktrees={worktrees}
            selectedBranch={selectedBranch}
            setSelectedBranch={setSelectedBranch}
            onRefresh={() => void refreshGit()}
            hasProject={!!selectedProject}
          />
        ) : null}
      </section>
      ) : null}
      {sidebarVisible ? <div className="resizeHandle leftHandle" onPointerDown={(event) => startResize("left", event)} /> : null}

      <section className="workspace">
        <nav className="tabs">
          {(["chat", "diff", "data"] as const).map((tab) => (
            <button key={tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
              {tab}
            </button>
          ))}
        </nav>
        <div className="content">
          {activeTab === "chat" ? <ChatView chat={activeChat} busy={busy} onShowDiff={() => setActiveTab("diff")} /> : null}
          {activeTab === "diff" ? (
            <DiffView
              diff={gitDiff}
              hasProject={!!selectedProject}
              onOpenFile={(path, line) => setActiveFile({ path, line, snippet: "Changed in current diff" })}
            />
          ) : null}
          {activeTab === "data" ? <DataView telemetry={telemetry} onCopy={copyTelemetry} /> : null}
        </div>
        <footer className="composer">
          <div className="composerMeta">
            <label>
              <GitBranch size={14} />
              <select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} disabled={branchInfo.branches.length === 0}>
                {!selectedBranch ? <option value="">No branch</option> : null}
                {selectedBranch ? <option value={selectedBranch}>{selectedBranch}</option> : null}
                {branchInfo.branches.filter((branch) => branch !== selectedBranch).map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
            <label className={activeChat.worktreeEnabled ? "worktreeCheck active" : "worktreeCheck"}>
              <input
                type="checkbox"
                checked={activeChat.worktreeEnabled}
                onChange={(event) => toggleWorktree(event.target.checked)}
                disabled={!selectedProject}
              />
              <GitFork size={14} />
              <span>{activeChat.worktreePath ? cleanPath(activeChat.worktreePath) : "Create worktree on send"}</span>
            </label>
            <div className="menuControl composerMenu">
              <button
                type="button"
                className="permissionButton"
                onClick={() => setPermissionMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={permissionMenuOpen}
              >
                <span>{permissionMode === "default" ? "Default permissions" : "Bypass permissions"}</span>
                <ChevronDown size={14} />
              </button>
              {permissionMenuOpen ? (
                <div className="menuPopover permissionMenu" role="menu">
                  <button type="button" role="menuitem" onClick={() => choosePermissionMode("default")}>
                    <span>Default permissions</span>
                    <small>Approve once per chat</small>
                  </button>
                  <button type="button" role="menuitem" onClick={() => choosePermissionMode("bypass")}>
                    <span>Bypass permissions</span>
                    <small>Auto-run safe tools</small>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <textarea
            value={prompt}
            placeholder={socketState === "open" ? "Ask Gemma for a local coding task..." : "Connecting to daemon..."}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendTask();
              }
            }}
          />
          <button title="Send task" onClick={sendTask} disabled={busy || socketState !== "open" || prompt.trim().length === 0}>
            <Play size={18} />
          </button>
        </footer>
      </section>
      <div className="resizeHandle rightHandle" onPointerDown={(event) => startResize("right", event)} />

      <aside className="inspect">
        <section className="panel">
          <div className="panelHeader">
            <h2>Tool Activity</h2>
            <button className="tinyButton" onClick={() => setActiveTab("data")} title="View collected data">
              <Database size={14} />
            </button>
          </div>
          <div className="timeline">
            {agentTimeline.length === 0 ? <div className="emptyState">Agent activity for this chat appears here.</div> : null}
            {agentTimeline.map((row) => (
              <div className="toolRow" key={row.id}>
                {row.status === "ready" ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}
                <div>
                  <strong>{row.name}</strong>
                  <span>{row.detail}</span>
                </div>
                <small data-status={row.status}>{row.at}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h2>Selected Context</h2>
          {activeFile ? (
            <button className="contextTarget" onClick={() => setActiveTab("diff")}>
              <strong>{activeFile.path}:{activeFile.line}</strong>
              <span>{activeFile.snippet}</span>
            </button>
          ) : (
            <div className="emptyState">Select a changed file in Diff to target it for IDE handoff.</div>
          )}
        </section>
        <section className="panel">
          <h2>Runtime</h2>
          <dl>
            <dt>Bridge</dt>
            <dd>{connection?.status ?? "starting"}</dd>
            <dt>Project</dt>
            <dd>{cleanPath(activeChat.worktreePath ?? selectedProject?.root_path) || "none"}</dd>
            <dt>Branch</dt>
            <dd>{selectedBranch || "none"}</dd>
            <dt>IDE</dt>
            <dd>{ides.find((ide) => ide.id === selectedIdeId)?.label ?? "not detected"}</dd>
          </dl>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </aside>

      <footer className="statusbar">
        <span>Daemon: {health?.daemon ?? (socketState === "open" ? "ready" : "starting")}</span>
        <span>LM Studio: {health?.lm_studio ?? "checking"}</span>
        <span>Index: {health?.semantic_index ?? "pending"}</span>
        <span>Permissions: {permissionMode === "default" ? "default" : "bypass"}</span>
      </footer>
      {showBypassConfirm ? (
        <div className="modalScrim" role="dialog" aria-modal="true" aria-labelledby="bypass-title">
          <section className="confirmDialog">
            <div>
              <h2 id="bypass-title">Bypass permissions?</h2>
              <p>
                Aegis will auto-run non-destructive read tools for this chat. Destructive actions and tool creation still require approval.
              </p>
            </div>
            <div className="dialogActions">
              <button type="button" className="secondaryAction" onClick={() => setShowBypassConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primaryAction"
                onClick={() => {
                  setPermissionMode("bypass");
                  setShowBypassConfirm(false);
                }}
              >
                Enable bypass
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function RailButton({ active, title, onClick, children }: React.PropsWithChildren<{ active: boolean; title: string; onClick: () => void }>) {
  return (
    <button className={`railItem ${active ? "active" : ""}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function IdeGlyph({ id }: { id: string }) {
  if (id === "code") {
    return <span className="vscodeMark">VS</span>;
  }
  if (id === "explorer") {
    return <FolderOpen size={16} />;
  }
  return <FileCode2 size={16} />;
}

function DataView({ telemetry, onCopy }: { telemetry: unknown; onCopy: () => void }) {
  return (
    <div className="dataView">
      <div className="dataHeader">
        <div>
          <h1>Collected Data</h1>
          <p>Connection health, project state, chat activity, sessions, git context, worktrees, model choice, permissions, and recent errors.</p>
        </div>
        <button className="secondaryButton compactButton" onClick={onCopy}>
          <Copy size={15} />
          <span>Copy JSON</span>
        </button>
      </div>
      <pre>{JSON.stringify(telemetry, null, 2)}</pre>
    </div>
  );
}

function SidebarChats({
  chats,
  activeChatId,
  onSelect,
  onDelete,
}: {
  chats: LocalChat[];
  activeChatId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="list">
      {chats.map((chat) => (
        <div
          className={`listItem chatItem ${chat.id === activeChatId ? "active" : ""}`}
          key={chat.id}
        >
          <button type="button" className="chatSelectButton" onClick={() => onSelect(chat.id)}>
            <strong>{chat.title}</strong>
            <span>{chat.branch || "no branch"} · {chat.messages.length} messages</span>
          </button>
          <button type="button" className="chatDeleteButton" title="Delete chat" onClick={() => onDelete(chat.id)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function SidebarGit({
  status,
  diff,
  branchInfo,
  worktrees,
  selectedBranch,
  setSelectedBranch,
  onRefresh,
  hasProject,
}: {
  status: GitResult | null;
  diff: GitResult | null;
  branchInfo: GitBranchInfo;
  worktrees: GitWorktreeInfo[];
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  onRefresh: () => void;
  hasProject: boolean;
}) {
  return (
    <div className="sidebarStack">
      <button className="secondaryButton" onClick={onRefresh} disabled={!hasProject}>
        Refresh Git
      </button>
      <select className="branchSelect" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} disabled={!hasProject}>
        {!selectedBranch ? <option value="">No branch</option> : null}
        {selectedBranch ? <option value={selectedBranch}>{selectedBranch}</option> : null}
        {branchInfo.branches.filter((branch) => branch !== selectedBranch).map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </select>
      {!hasProject ? <div className="emptyState">Open a project to inspect git status.</div> : null}
      {status ? <pre className="miniPre">{status.stdout || status.stderr || "Working tree clean."}</pre> : null}
      {diff ? <div className="statLine">{diff.stdout ? `${diff.stdout.split("\n").length} diff lines` : "No unstaged diff"}</div> : null}
      {worktrees.length > 0 ? (
        <div className="worktreeList">
          {worktrees.map((row) => (
            <div key={row.path}>
              <strong>{row.branch || "detached"}</strong>
              <span>{cleanPath(row.path)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChatView({ chat, busy, onShowDiff }: { chat: LocalChat; busy: boolean; onShowDiff: () => void }) {
  if (chat.messages.length === 0 && !busy) {
    return (
      <div className="blankSlate">
        <h1>Local Coding Agent</h1>
        <p>Open a folder, choose a branch, then ask for a coding change. Each chat keeps its own messages and tool trail.</p>
      </div>
    );
  }
  const lastMessage = chat.messages[chat.messages.length - 1];
  const hasStreamingAssistant = lastMessage?.role === "assistant" && lastMessage.content.length > 0;
  return (
    <div className="chatStream">
      {chat.messages.map((line, index) => (
        <article className={`message ${line.role}`} key={`${line.role}-${index}`}>
          <span>{line.role}</span>
          <p>{line.content}</p>
        </article>
      ))}
      {chat.diffAvailable ? (
        <div className="chatDiffNotice">
          <GitBranch size={15} />
          <span>{chat.changedFileCount ?? 0} changed file{chat.changedFileCount === 1 ? "" : "s"} detected</span>
          <button type="button" onClick={onShowDiff}>View diff</button>
        </div>
      ) : null}
      {busy && !hasStreamingAssistant ? (
        <article className="message assistant pending">
          <span>assistant</span>
          <p>Generating response...</p>
        </article>
      ) : null}
    </div>
  );
}

type ParsedDiffLine = {
  kind: "meta" | "hunk" | "add" | "remove" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
};

type ParsedDiffFile = {
  oldPath: string;
  newPath: string;
  lines: ParsedDiffLine[];
};

function parseDiff(text: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { oldPath: "", newPath: "", lines: [{ kind: "meta", content: line }] };
      files.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = line.replace(/^---\s+a\//, "").trim();
      current.lines.push({ kind: "meta", content: line });
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = line.replace(/^\+\+\+\s+b\//, "").trim();
      current.lines.push({ kind: "meta", content: line });
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = match ? Number(match[1]) : oldLine;
      newLine = match ? Number(match[2]) : newLine;
      current.lines.push({ kind: "hunk", content: line });
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", content: line, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ kind: "remove", content: line, oldLine });
      oldLine += 1;
      continue;
    }
    current.lines.push({ kind: "context", content: line, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return files.filter((file) => file.newPath || file.oldPath || file.lines.length > 1);
}

function firstChangedLine(file: ParsedDiffFile): number {
  return file.lines.find((line) => line.kind === "add" && line.newLine)?.newLine ?? 1;
}

function DiffView({
  diff,
  hasProject,
  onOpenFile,
}: {
  diff: GitResult | null;
  hasProject: boolean;
  onOpenFile: (path: string, line: number) => void;
}) {
  if (!hasProject) {
    return <div className="blankSlate"><h1>Diff</h1><p>Open a project to inspect the current git diff.</p></div>;
  }
  const diffText = diff?.stdout ?? "";
  if (!diffText.trim()) {
    return <div className="blankSlate"><h1>Diff</h1><p>{diff?.stderr || "No unstaged diff in the selected project."}</p></div>;
  }
  const files = parseDiff(diffText);
  return (
    <div className="diffView">
      {files.map((file) => (
        <details className="diffFile" key={`${file.oldPath}-${file.newPath}`} open>
          <summary className="diffFileHeader">
            <ChevronDown size={15} />
            <button type="button" onClick={(event) => {
              event.preventDefault();
              onOpenFile(file.newPath || file.oldPath, firstChangedLine(file));
            }}>
              <Eye size={15} />
              <span>{file.newPath || file.oldPath}</span>
            </button>
          </summary>
          <div className="diffCode">
            {file.lines.map((line, index) => (
              <div className={`diffLine ${line.kind}`} key={`${line.kind}-${index}`}>
                <span className="lineNo">{line.oldLine ?? ""}</span>
                <span className="lineNo">{line.newLine ?? ""}</span>
                <code>{line.content}</code>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
