import React from "react";
import { File, Folder, X } from "lucide-react";
import type { ChatAttachment } from "../shared/desktopApi";
import { isImageAttachment, normalizeAttachment } from "./chatListPresentation";
import { attachmentLabel } from "./composerText";

export { normalizeAttachment };

export function AttachmentPreviewList({
  files,
  mode,
  onRemove,
  onOpen,
}: {
  files: ChatAttachment[];
  mode: "composer" | "message";
  onRemove?: (file: ChatAttachment) => void;
  onOpen?: (file: ChatAttachment) => void;
}) {
  if (!files.length) return null;
  return (
    <div
      className={`attachmentPreviewList ${mode === "composer" ? "composerAttachmentList" : "messageAttachmentList"} hasAttachments`}
    >
      {files.map((file) => {
        const key = file.storedPath || file.path;
        const label = attachmentLabel(file);
        const image = isImageAttachment(file) && file.previewDataUrl;
        const interactive = !!onOpen && !onRemove;
        const previewContent = image ? (
          <img alt={label} src={file.previewDataUrl} />
        ) : (
          <>
            <span className="attachmentPreviewFileIcon">
              {file.kind === "folder" ? <Folder size={14} /> : <File size={14} />}
            </span>
            <span className="attachmentPreviewFileName">{label}</span>
          </>
        );
        const className = `attachmentPreview ${image ? "imageAttachment" : "fileAttachment"} ${
          interactive ? "interactiveAttachment" : ""
        }`;
        return (
          <React.Fragment key={key}>
            {interactive ? (
              <button className={className} type="button" onClick={() => onOpen(file)} title={label}>
                {previewContent}
              </button>
            ) : (
              <div className={className} title={label}>
                {previewContent}
                {onRemove ? (
                  <button className="attachmentPreviewRemove" type="button" onClick={() => onRemove(file)} title={`Remove ${label}`}>
                    <X size={13} />
                  </button>
                ) : null}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
