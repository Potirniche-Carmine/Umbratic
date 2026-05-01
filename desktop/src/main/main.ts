import { app, BrowserWindow, dialog, ipcMain, Menu, OpenDialogOptions } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import fs = require("node:fs");
import path = require("node:path");

type DaemonConnection =
  | { status: "ready"; url: string; token: string }
  | { status: "missing"; message: string }
  | { status: "error"; message: string };

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let daemonProcess: ChildProcess | null = null;
let daemonConnection: Promise<DaemonConnection> | null = null;

function daemonBinaryPath(): string {
  const exe = process.platform === "win32" ? "aegis-app.exe" : "aegis-app";
  if (isDev) {
    return path.resolve(__dirname, "../../../aegis-daemon/target/debug", exe);
  }
  return path.join(process.resourcesPath, "daemon", exe);
}

async function startDaemon(): Promise<DaemonConnection> {
  if (daemonConnection) {
    return daemonConnection;
  }

  daemonConnection = new Promise((resolve) => {
    const binary = daemonBinaryPath();
    if (!fs.existsSync(binary)) {
      resolve({
        status: "missing",
        message: `Daemon binary not found at ${binary}. Run npm run daemon:build after installing Rust.`,
      });
      daemonConnection = null;
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(binary, [], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      try {
        child = spawn(process.platform === "win32" ? "cmd.exe" : binary, process.platform === "win32" ? ["/d", "/s", "/c", `"${binary}"`] : [], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (fallbackError) {
        resolve({
          status: "error",
          message: `Failed to start daemon at ${binary}: ${String(fallbackError || error)}`,
        });
        daemonConnection = null;
        return;
      }
    }
    daemonProcess = child;

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const settle = (connection: DaemonConnection) => {
      if (!settled) {
        settled = true;
        resolve(connection);
        if (connection.status !== "ready") {
          daemonConnection = null;
        }
      }
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "ENOENT"
          ? `Daemon binary not found at ${binary}. Run npm run daemon:build after installing Rust.`
          : `Failed to start daemon at ${binary}: ${error.message}`;
      settle({ status: error.code === "ENOENT" ? "missing" : "error", message });
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
      daemonConnection = null;
      settle({
        status: "error",
        message: `Daemon exited before startup. Code ${code ?? "unknown"}. ${stderrBuffer}`.trim(),
      });
    });

    setTimeout(() => {
      settle({
        status: "error",
        message: `Timed out waiting for daemon startup. ${stderrBuffer}`.trim(),
      });
    }, 6000);
  });

  return daemonConnection;
}

async function restartDaemon(): Promise<DaemonConnection> {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  }
  daemonConnection = null;
  return startDaemon();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#111416",
    title: "Aegis",
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
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
