import React from "react";
import { Copy } from "lucide-react";
import type { ChatAttachment } from "../shared/desktopApi";
import { AttachmentPreviewList } from "./attachmentPreview";

/** User text and attachments have one compact presentation across all providers. */
export function UserPrompt({ text, files, feedback, onOpen, onCopy }: {
  text: string; files: ChatAttachment[]; feedback?: React.ReactNode; onOpen(file: ChatAttachment): void; onCopy(): void;
}) {
  return <article className="timelineMessage userMessage">
    <div className="userMessageBubble">
      {text && <p className="userPromptText">{text}</p>}
      {feedback}
      <AttachmentPreviewList files={files} mode="message" onOpen={onOpen}/>
    </div>
    <div className="messageActions"><button className="messageAction" type="button" onClick={onCopy} title="Copy prompt"><Copy size={14}/></button></div>
  </article>;
}
