import React from "react";
import type { CloudImage } from "../../shared/cloud";
import { AttachmentPreviewDialog } from "../AttachmentPreviewDialog";

export function CloudAttachmentPreview({ file, onClose }: { file: CloudImage; onClose(): void }) {
  return <AttachmentPreviewDialog name={file.name} imageUrl={file.previewDataUrl} onClose={onClose}/>;
}
