import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export async function verifyLlamaDownloads(file: string): Promise<void> {
  // Omit --offline: the compiled constructor must reject before connecting,
  // including when a caller forgets that launch flag. A live listener catches
  // clients that print the denial only after making a connection.
  let connected = false;
  const listener = net.createServer((socket) => { connected = true; socket.destroy(); });
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-download-probe-"));
  try {
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as net.AddressInfo).port;
    for (const scheme of ["http", "https"]) {
      await new Promise<void>((resolve, reject) => {
        // llama-server registers backends before resolving the model URL.
        // Metal registration compiles kernels on a cold host. This model-free
        // security probe needs only CPU; production GPU configuration is separate.
        execFile(file, ["--device", "none", "--n-gpu-layers", "0", "--model-url",
          `${scheme}://127.0.0.1:${port}/model.gguf`, "-m", path.join(probe, "model.gguf")], {
          encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024,
          env: { ...process.env, GGML_METAL_DEVICES: "0" },
        }, (error, stdout, stderr) => {
          if (!error || error.killed || error.signal || typeof error.code !== "number" || error.code === 0
              || !`${stdout}${stderr}`.includes("Remote downloads are disabled in the Umbratic runtime.")) {
            const details = JSON.stringify({ code: error?.code ?? null, signal: error?.signal ?? null,
              killed: error?.killed ?? false, error: error?.message?.slice(0, 256) ?? null,
              stdout: stdout.slice(-2048), stderr: stderr.slice(-2048) });
            reject(new Error(`Packaged llama-server did not reject ${scheme.toUpperCase()} model downloads. ${details}`));
          } else resolve();
        });
      });
    }
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    fs.rmSync(probe, { recursive: true, force: true });
  }
  if (connected) throw new Error("Packaged llama-server attempted a disabled remote download.");
}
