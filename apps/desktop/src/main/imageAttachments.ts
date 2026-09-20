import { nativeImage } from "electron";
import * as path from "node:path";

export function imageMimeType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

export function imagePreviewDataUrl(filePath: string): string | undefined {
  try {
    if (!imageMimeType(filePath)) return undefined;
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    const longestSide = Math.max(size.width, size.height);
    const thumbnail = longestSide > 220
      ? image.resize({
          width: size.width >= size.height ? 220 : undefined,
          height: size.height > size.width ? 220 : undefined,
          quality: "good",
        })
      : image;
    return thumbnail.toDataURL();
  } catch {
    return undefined;
  }
}
