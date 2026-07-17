import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const source = path.join(desktopRoot, "src/main/system-skills");
const target = path.join(desktopRoot, "dist-electron/main/system-skills");

if (!fs.existsSync(source)) {
  throw new Error(`System skills source folder is missing: ${source}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

