import { app, BrowserWindow, dialog, ipcMain, Menu, OpenDialogOptions, shell } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import fs = require("node:fs");
import path = require("node:path");

type DaemonConnection =
  | { status: "ready"; url: string; token: string }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

type AttachedFilePayload = {
  path: string;
  name: string;
  projectPath?: string;
  content?: string;
};

const isDev = !app.isPackaged;

// Override userData away from "@aegis/desktop" — the "@" in the package name
// makes Electron's default path "AppData\Roaming\@aegis\desktop", and Windows
// CreateProcess fails with `spawn UNKNOWN` on paths containing "@".
app.setName("Aegis");
const cleanUserData = path.join(app.getPath("appData"), "Aegis");
try {
  fs.mkdirSync(cleanUserData, { recursive: true });
  app.setPath("userData", cleanUserData);
} catch {
  /* fall back to default */
}

let mainWindow: BrowserWindow | null = null;
let daemonProcess: ChildProcess | null = null;
let daemonConnection: Promise<DaemonConnection> | null = null;
let terminalProcess: ChildProcess | null = null;

function daemonSourcePath(): string {
  const exe = process.platform === "win32" ? "aegis-app.exe" : "aegis-app";
  if (isDev) {
    const release = path.resolve(__dirname, "../../../aegis-daemon/target/release", exe);
    const debug = path.resolve(__dirname, "../../../aegis-daemon/target/debug", exe);
    if (fs.existsSync(release) && fs.existsSync(debug)) {
      return fs.statSync(debug).mtimeMs >= fs.statSync(release).mtimeMs ? debug : release;
    }
    return fs.existsSync(release) ? release : debug;
  }
  return path.join(process.resourcesPath, "daemon", exe);
}

function ensureRunnableBinary(): string {
  const source = daemonSourcePath();
  if (process.platform !== "win32" || !fs.existsSync(source)) {
    return source;
  }
  const exe = "aegis-app.exe";
  const targetDir = path.join(app.getPath("userData"), "daemon");
  const target = path.join(targetDir, exe);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const sourceStat = fs.statSync(source);
    const targetExists = fs.existsSync(target);
    let needsCopy = isDev || !targetExists;
    if (!needsCopy && targetExists) {
      const targetStat = fs.statSync(target);
      if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        needsCopy = false;
      }
    }
    if (needsCopy) {
      fs.copyFileSync(source, target);
      try {
        fs.unlinkSync(`${target}:Zone.Identifier`);
      } catch {
        /* nothing to unblock */
      }
    }
    return target;
  } catch {
    return source;
  }
}

function explainDaemonError(message: string, binary: string): string {
  if (/Device Guard|Smart App Control|blocked by your organization|This program is blocked/i.test(message)) {
    return [
      message.trim(),
      "",
      "Windows Smart App Control or a Device Guard / WDAC policy is blocking the unsigned debug binary.",
      "Defender exclusions do not apply here. Try one of:",
      "  1. Build the release binary (the desktop app prefers it automatically):",
      "       cd aegis-daemon ; cargo build --release -p aegis-app",
      "  2. Self-sign the binary so SAC / WDAC accepts it:",
      "       PowerShell:",
      "       $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Aegis Dev' -CertStoreLocation Cert:\\CurrentUser\\My",
      "       Export-Certificate -Cert $cert -FilePath aegis-dev.cer | Out-Null",
      "       Import-Certificate -FilePath aegis-dev.cer -CertStoreLocation Cert:\\CurrentUser\\Root",
      "       Set-AuthenticodeSignature -FilePath '<path-to-aegis-app.exe>' -Certificate $cert",
      "  3. Open Windows Security → App & browser control → Smart App Control, then turn it Off (one-way) or set Evaluation mode.",
      "",
      `Resolved daemon path: ${binary}`,
    ].join("\n");
  }
  if (/spawn\s+UNKNOWN/i.test(message)) {
    return [
      message.trim(),
      "",
      "Windows refused to launch the binary via CreateProcess (errno UNKNOWN). The release binary that runs on double-click is going through ShellExecute, which honors SmartScreen approvals — programmatic spawn does not.",
      "",
      "Best fixes (any one of these resolves it):",
      "  1. Build a release binary — the desktop app prefers it automatically:",
      "       cd aegis-daemon ; cargo build --release -p aegis-app",
      "     Then relaunch the desktop app.",
      "  2. Self-sign the daemon (one-time, ~30 sec). In PowerShell:",
      "       $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Aegis Dev' -CertStoreLocation Cert:\\CurrentUser\\My",
      "       Export-Certificate -Cert $cert -FilePath $env:TEMP\\aegis-dev.cer | Out-Null",
      "       Import-Certificate -FilePath $env:TEMP\\aegis-dev.cer -CertStoreLocation Cert:\\CurrentUser\\Root",
      `       Set-AuthenticodeSignature -FilePath '${binary}' -Certificate $cert`,
      "  3. Disable Smart App Control: Windows Security → App & browser control → Smart App Control → Off.",
      "",
      `Resolved daemon path: ${binary}`,
    ].join("\n");
  }
  return message;
}

type AttemptResult =
  | DaemonConnection
  | { status: "retry-spawn"; message: string };

function attemptStart(binary: string, useShell: boolean): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const baseOptions = {
      cwd: path.dirname(binary),
      stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
      windowsHide: true,
    };

    let child: ChildProcess;
    try {
      child = useShell
        ? spawn(`"${binary}"`, [], { ...baseOptions, shell: true } as Parameters<typeof spawn>[2])
        : spawn(binary, [], baseOptions as Parameters<typeof spawn>[2]);
    } catch (error) {
      const message = `Failed to start daemon at ${binary}: ${String(error)}`;
      if (/UNKNOWN/i.test(message) && !useShell) {
        resolve({ status: "retry-spawn", message });
      } else {
        resolve({ status: "error", message });
      }
      return;
    }
    daemonProcess = child;

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const settle = (result: AttemptResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle({
          status: "missing",
          message: `Daemon binary not found at ${binary}. Run npm run daemon:build after installing Rust.`,
        });
        return;
      }
      const message = `Failed to start daemon at ${binary}: ${error.message}`;
      if (error.code === "UNKNOWN" && !useShell) {
        settle({ status: "retry-spawn", message });
        return;
      }
      settle({ status: "error", message });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 8000) {
        stderrBuffer = stderrBuffer.slice(-8000);
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = stdoutBuffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line) as { url?: string; token?: string };
        if (parsed.url && parsed.token) {
          settle({ status: "ready", url: parsed.url, token: parsed.token });
        } else {
          settle({ status: "error", message: "Daemon startup line did not include url and token." });
        }
      } catch (error) {
        settle({ status: "error", message: `Could not parse daemon startup line: ${String(error)}` });
      }
    });

    child.once("exit", (code) => {
      daemonProcess = null;
      const raw = `Daemon exited before startup. Code ${code ?? "unknown"}. ${stderrBuffer}`.trim();
      settle({ status: "error", message: raw });
    });

    setTimeout(() => {
      settle({ status: "error", message: `Timed out waiting for daemon startup. ${stderrBuffer}`.trim() });
    }, 6000);
  });
}

async function startDaemon(): Promise<DaemonConnection> {
  if (daemonConnection) {
    return daemonConnection;
  }

  daemonConnection = (async (): Promise<DaemonConnection> => {
    const binary = ensureRunnableBinary();
    if (!fs.existsSync(binary)) {
      return {
        status: "missing",
        message: `Daemon binary not found at ${binary}. Run npm run daemon:build after installing Rust.`,
      };
    }

    let attempt = await attemptStart(binary, false);

    // On Windows, if CreateProcess fails with UNKNOWN, retry once via the shell.
    // CMD-mediated spawn uses a different code path that sometimes survives
    // restrictive WDAC / SmartScreen policies that block direct CreateProcess.
    if (attempt.status === "retry-spawn" && process.platform === "win32") {
      if (daemonProcess) {
        try { daemonProcess.kill(); } catch { /* ignore */ }
        daemonProcess = null;
      }
      attempt = await attemptStart(binary, true);
    }

    if (attempt.status === "ready") {
      return attempt;
    }
    if (attempt.status === "missing") {
      return attempt;
    }
    const message = attempt.status === "retry-spawn" ? attempt.message : attempt.message ?? "Daemon failed to start.";
    return { status: "error", message: explainDaemonError(message, binary) };
  })();

  const result = await daemonConnection;
  if (result.status !== "ready") {
    daemonConnection = null;
  }
  return result;
}

async function restartDaemon(): Promise<DaemonConnection> {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  }
  daemonConnection = null;
  return startDaemon();
}

function readAttachment(filePath: string, projectRoot?: string): AttachedFilePayload {
  const payload: AttachedFilePayload = {
    path: filePath,
    name: path.basename(filePath),
  };
  if (projectRoot) {
    const relative = path.relative(projectRoot, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      payload.projectPath = relative.replace(/\\/g, "/");
    }
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size <= 64 * 1024) {
      const buffer = fs.readFileSync(filePath);
      if (!buffer.includes(0)) {
        payload.content = buffer.toString("utf8");
      }
    }
  } catch {
    /* best-effort attachment preview */
  }
  return payload;
}

function terminalShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo"] };
  }
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { command: shell, args: [] };
}

function startTerminal(cwd?: string): { started: boolean; shell: string } {
  if (terminalProcess) {
    return { started: true, shell: terminalProcess.spawnfile };
  }
  const shell = terminalShell();
  terminalProcess = spawn(shell.command, shell.args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath("home"),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  terminalProcess.stdout?.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("terminal:data", chunk.toString("utf8"));
  });
  terminalProcess.stderr?.on("data", (chunk: Buffer) => {
    mainWindow?.webContents.send("terminal:data", chunk.toString("utf8"));
  });
  terminalProcess.once("exit", (code) => {
    mainWindow?.webContents.send("terminal:data", `\r\n[terminal exited: ${code ?? "unknown"}]\r\n`);
    terminalProcess = null;
  });
  terminalProcess.once("error", (error) => {
    mainWindow?.webContents.send("terminal:data", `\r\n[terminal error: ${error.message}]\r\n`);
    terminalProcess = null;
  });
  return { started: true, shell: shell.command };
}

function launchCommand(command: string, args: string[]): { ok: true } | { ok: false; message: string } {
  // Spawn an external editor reliably on Windows. Direct spawn with shell:true
  // breaks for paths with spaces (e.g. "C:\Program Files\Microsoft VS Code\Code.exe"),
  // and direct spawn fails for .cmd / .bat shims (e.g. code.cmd) because Windows
  // refuses to CreateProcess a batch file. Pick the right strategy per command.
  if (!command) {
    return { ok: false, message: "No command for the chosen editor." };
  }
  try {
    const isWindows = process.platform === "win32";
    const isBatch = isWindows && /\.(cmd|bat)$/i.test(command);
    const child = isBatch
      ? spawn("cmd.exe", ["/c", command, ...args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn(command, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
    child.once("error", (error) => {
      console.error(`[aegis] failed to launch ${command}:`, error);
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error instanceof Error ? error.message : error) };
  }
}

async function createWindow() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0c0d0f",
    title: "Aegis",
    titleBarStyle: isMac ? "hiddenInset" : isWin ? "hidden" : "default",
    titleBarOverlay: isWin
      ? {
          color: "#0c0d0f",
          symbolColor: "#cdd3d9",
          height: 44,
        }
      : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: path.resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.resolve(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("daemon:get-connection", () => startDaemon());
  ipcMain.handle("daemon:restart", () => restartDaemon());
  ipcMain.handle("project:pick-folder", async () => {
    const options: OpenDialogOptions = {
      title: "Open Project Folder",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const rootPath = result.filePaths[0];
    return {
      canceled: false,
      rootPath,
      name: path.basename(rootPath),
    };
  });
  ipcMain.handle("file:pick-attachments", async (_event, projectRoot?: string) => {
    const options: OpenDialogOptions = {
      title: "Attach Files",
      properties: ["openFile", "multiSelections"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return {
      canceled: false,
      files: result.filePaths.map((filePath) => readAttachment(filePath, projectRoot)),
    };
  });
  ipcMain.handle(
    "ide:open-project",
    async (_event, payload: { ideId: string; command: string; projectRoot: string }) => {
      try {
        const root = path.resolve(payload.projectRoot);
        if (!fs.existsSync(root)) {
          return { ok: false, message: `Project root does not exist: ${root}` };
        }
        if (payload.ideId === "explorer") {
          const error = await shell.openPath(root);
          if (error) {
            return { ok: false, message: error };
          }
          return { ok: true };
        }
        return launchCommand(payload.command, [root]);
      } catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
      }
    },
  );
  ipcMain.handle(
    "ide:open-file",
    async (
      _event,
      payload: { ideId: string; command: string; projectRoot: string; file: string; line?: number | null },
    ) => {
      try {
        const root = path.resolve(payload.projectRoot);
        const target = path.isAbsolute(payload.file) ? payload.file : path.join(root, payload.file);
        if (!fs.existsSync(target)) {
          return { ok: false, message: `File does not exist: ${target}` };
        }
        if (payload.ideId === "explorer") {
          shell.showItemInFolder(target);
          return { ok: true };
        }
        if (payload.ideId === "code") {
          const gotoArg = payload.line ? `${target}:${payload.line}` : target;
          const args = payload.line
            ? ["--reuse-window", root, "--goto", gotoArg]
            : ["--reuse-window", root, target];
          return launchCommand(payload.command, args);
        }
        return launchCommand(payload.command, [target]);
      } catch (error) {
        return { ok: false, message: String(error instanceof Error ? error.message : error) };
      }
    },
  );
  ipcMain.handle("terminal:start", (_event, cwd?: string) => startTerminal(cwd));
  ipcMain.handle("terminal:write", (_event, data: string) => {
    if (!terminalProcess) {
      startTerminal();
    }
    terminalProcess?.stdin?.write(data);
    return { written: true };
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open Folder...",
            accelerator: "CmdOrCtrl+O",
            click: () => mainWindow?.webContents.send("menu:open-project"),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Back to Chat",
            accelerator: "Alt+Left",
            click: () => mainWindow?.webContents.send("menu:back-to-chat"),
          },
          {
            label: "Toggle Sidebar",
            accelerator: "CmdOrCtrl+B",
            click: () => mainWindow?.webContents.send("menu:toggle-sidebar"),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "About Aegis",
            click: () => mainWindow?.webContents.send("menu:show-about"),
          },
        ],
      },
    ]),
  );
  await createWindow();
  void startDaemon();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (daemonProcess) {
    daemonProcess.kill();
  }
  if (terminalProcess) {
    terminalProcess.kill();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
