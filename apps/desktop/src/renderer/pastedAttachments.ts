import type { PastedAttachmentInput } from "../shared/desktopApi";

export function fileToPastedAttachment(file: File): Promise<PastedAttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve({ name: file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "pasted-file"), mimeType: file.type || undefined, dataUrl: reader.result })
      : reject(new Error("Could not read pasted file."));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted file."));
    reader.readAsDataURL(file);
  });
}
