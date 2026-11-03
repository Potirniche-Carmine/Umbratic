import { app, nativeImage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { CloudImage, CloudImageInput } from "../shared/cloud";

const maxBytes = 20 * 1024 * 1024;
function directory(): string {
  const root = path.join(app.getPath("userData"), "cloud", "images");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
export function saveCloudImages(input: { files: CloudImageInput[] }): CloudImage[] {
  if (!Array.isArray(input?.files) || !input.files.length || input.files.length > 20) throw new Error("Attach up to 20 files at a time.");
  // Validate the entire batch before writing. Normalize to PNG so MIME, bytes,
  // previews and the provider's image input always agree.
  const prepared = input.files.map(file => {
    if (typeof file?.dataUrl !== "string" || file.dataUrl.length > maxBytes * 1.4) throw new Error("Each image must be smaller than 20 MB.");
    const document = /^data:([^;,]*);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(file.dataUrl);
    if (document && !document[1].startsWith("image/")) {
      const bytes = Buffer.from(document[2], "base64");
      if (bytes.length > maxBytes) throw new Error("Each attachment must be smaller than 20 MB.");
      const name = path.basename(String(file.name || "Attachment.txt")).slice(0, 160);
      const extension = path.extname(name).toLowerCase();
      const pdf = extension === ".pdf" && bytes.subarray(0, 5).toString() === "%PDF-";
      const textExtensions = [".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".c", ".h", ".cpp", ".sql", ".log"];
      if (!pdf && (!textExtensions.includes(extension) || bytes.includes(0))) throw new Error("Choose an image, PDF, or text/code file.");
      if (!pdf) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { image: { id: randomUUID(), name, mimeType: pdf ? "application/pdf" : "text/plain", extension, previewDataUrl: "" } as CloudImage, png: bytes };
    }
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(file.dataUrl);
    if (!match) throw new Error("Choose an image, PDF, or text/code file.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > maxBytes) throw new Error("Each image must be smaller than 20 MB.");
    const decoded = nativeImage.createFromBuffer(bytes);
    if (decoded.isEmpty()) throw new Error("This image could not be read.");
    const size = decoded.getSize();
    if (size.width * size.height > 40_000_000) throw new Error("This image is too large. Resize it before attaching.");
    const png = decoded.toPNG();
    if (png.length > maxBytes) throw new Error("This image is too large. Resize it before attaching.");
    const image: CloudImage = { id: randomUUID(), name: String(file.name || "Pasted image").slice(0, 160), mimeType: "image/png",
      previewDataUrl: decoded.resize({ width: Math.min(size.width, 240) }).toDataURL() };
    return { image, png };
  });
  const root = directory();
  for (const { image, png } of prepared) {
    fs.writeFileSync(path.join(root, `${image.id}${image.extension || ".png"}`), png, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(root, `${image.id}.json`), JSON.stringify(image), { flag: "wx", mode: 0o600 });
  }
  return prepared.map(item => item.image);
}
export function resolveCloudImages(ids: string[]): { path: string; mimeType: string; image: CloudImage }[] {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Choose up to 20 attachments.");
  if (!ids.length) return [];
  const root = directory();
  return [...new Set(ids)].map(id => {
    const metadata = path.join(root, `${id}.json`);
    if (!fs.lstatSync(metadata).isFile()) throw new Error("Attach this file again.");
    const image = JSON.parse(fs.readFileSync(metadata, "utf8")) as CloudImage;
    if (image.extension && !/^\.[a-z0-9]{1,8}$/.test(image.extension)) throw new Error("Attach this file again.");
    const filename = path.join(root, `${id}${image.extension || ".png"}`);
    if (!fs.lstatSync(filename).isFile()) throw new Error("Attach this file again.");
    return { path: filename, mimeType: image.mimeType, image };
  });
}
