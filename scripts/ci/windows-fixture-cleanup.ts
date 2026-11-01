import fs from "node:fs";
import path from "node:path";

// Never restore normal outputs while an unconfirmed writer can still modify
// them. Preserve its PID/control files so the workflow's always-cleanup retries.
export function cleanupWindowsFixture(root: string, desktop: string, upload: string, stop: () => void, removeCertificate: () => void): void {
  if (!fs.existsSync(root)) return;
  try { stop(); } catch (error) {
    try {
      if (fs.existsSync(path.join(root, "identity.json"))) removeCertificate();
    } catch { /* Preserve the original stop failure and retry state. */ }
    throw error;
  }
  if (fs.existsSync(path.join(root, "identity.json"))) removeCertificate();
  if (fs.existsSync(path.join(root, "unsigned-desktop"))) {
    fs.rmSync(desktop, { recursive: true, force: true });
    fs.renameSync(path.join(root, "unsigned-desktop"), desktop);
    fs.rmSync(upload, { recursive: true, force: true });
    if (fs.existsSync(path.join(root, "unsigned-upload"))) fs.renameSync(path.join(root, "unsigned-upload"), upload);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
