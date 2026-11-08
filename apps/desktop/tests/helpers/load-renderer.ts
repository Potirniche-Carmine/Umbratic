import React from "react";

import { loadTypeScriptModule } from "./load-ts-module.ts";

const iconNames = [
  "Columns2", "Rows3", "MessageSquarePlus", "WrapText",
  "BookOpen", "FilePenLine", "Search", "Wrench", "AtSign", "BarChart3", "Brain", "Check", "ChevronDown", "ChevronLeft", "ChevronRight", "CheckCircle2", "CircleDashed", "CornerUpRight", "MessageSquareText", "Square",
  "Cloud", "Code", "Copy", "Ellipsis", "ExternalLink", "File", "FileText", "FolderOpen", "FolderPlus", "FolderX", "GitBranch", "Globe", "Hand", "Loader2", "LogOut", "MessageSquareX", "Mic",
  "Monitor", "Moon", "PanelRight", "Paperclip", "Pencil", "Play", "Plus", "RefreshCw", "RotateCcw", "Send", "Settings", "Maximize2", "Minimize2", "Minus", "Folder", "FileCode2", "ShieldOff", "Gauge", "Zap",
  "ShieldCheck", "Sparkles", "SquarePen", "SquareTerminal", "Sun", "ThumbsDown", "ThumbsUp",
  "Trash2", "TriangleAlert", "Type", "Undo2", "User", "X",
];

function browserGlobals() {
  const storage = new Map();
  const documentElement = {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty() {},
    },
  };
  return {
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, style: {}, select() {} }),
      documentElement,
      execCommand: () => true,
      getElementById: () => null,
    },
    navigator: { clipboard: undefined, platform: "Win32" },
    window: {
      clearTimeout,
      document: null,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
      },
      location: { search: "" },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (callback) => {
        callback();
        return 0;
      },
      setTimeout,
      umbratic: undefined,
    },
  };
}

export function loadRendererModule(moduleUrl: URL, mocks = {}) {
  const icon = (props) => React.createElement("svg", props);
  const lucide = Object.fromEntries(iconNames.map((name) => [name, icon]));
  return loadTypeScriptModule(moduleUrl, {
    cache: new Map(),
    globals: browserGlobals(),
    mocks: {
      "lucide-react": lucide,
      "react-dom/client": {
        createRoot: () => ({ render() {} }),
      },
      ...mocks,
    },
  });
}

export function loadRendererFile(file: string, mocks = {}) {
  return loadRendererModule(new URL(`../../src/renderer/${file}`, import.meta.url), mocks);
}

export function loadRenderer() {
  return loadRendererFile("main.tsx");
}
