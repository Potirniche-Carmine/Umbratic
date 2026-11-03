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
  if (!Array.isArray(input?.files) || !input.files.length || input.files.length > 8) throw new Error("Attach up to 8 images at a time.");
  // Validate the entire batch before writing. Normalize to PNG so MIME, bytes,
  // previews and the provider's image input always agree.
  const prepared = input.files.map(file => {
    if (typeof file?.dataUrl !== "string" || file.dataUrl.length > maxBytes * 1.4) throw new Error("Each image must be smaller than 20 MB.");
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(file.dataUrl);
    if (!match) throw new Error("Paste a PNG, JPEG, WebP or GIF image.");
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
    fs.writeFileSync(path.join(root, `${image.id}.png`), png, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(root, `${image.id}.json`), JSON.stringify(image), { flag: "wx", mode: 0o600 });
  }
  return prepared.map(item => item.image);
}
export function resolveCloudImages(ids: string[]): { path: string; mimeType: string; image: CloudImage }[] {
  if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Choose up to 8 attached images.");
  if (!ids.length) return [];
  const root = directory();
  return [...new Set(ids)].map(id => {
    const filename = path.join(root, `${id}.png`);
    const metadata = path.join(root, `${id}.json`);
    if (!fs.lstatSync(filename).isFile() || !fs.lstatSync(metadata).isFile()) throw new Error("Attach this image again.");
    const image = JSON.parse(fs.readFileSync(metadata, "utf8")) as CloudImage;
    return { path: filename, mimeType: "image/png", image };
  });
}
