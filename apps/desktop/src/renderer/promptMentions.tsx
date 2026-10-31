import React from "react";
import { File, Folder, Image, Sparkles } from "lucide-react";
import type { ChatAttachment, SkillInfo } from "../shared/desktopApi";
import { attachmentMention, matchHighlightSegments, promptHighlightSegments } from "./composerText";
import { normalizeAttachment } from "./attachmentPreview";
import type { PromptMention } from "./rendererTypes";

export type MentionCategoryId = "file" | "folder" | "skill" | "image";

export type MentionCategory = { id: MentionCategoryId; label: string; hint: string };

export const mentionCategories: MentionCategory[] = [
  { id: "image", label: "Image", hint: "Create an image with your chat model" },
  { id: "file", label: "Files", hint: "Attach a file from the project" },
  { id: "folder", label: "Folders", hint: "Reference a folder and everything in it" },
  { id: "skill", label: "Skills", hint: "Use a skill for this turn" },
];

export function mentionAtCursor(value: string, cursor: number): PromptMention | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)([@$])([^\s@$]*)$/);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[1].length;
  return { kind: match[2] === "$" ? "skill" : "file", query: match[3], start, end: cursor };
}

export function skillMention(skill: SkillInfo): string {
  return `$${skill.id}`;
}

export function mentionCategoryIcon(id: MentionCategoryId): React.ReactNode {
  switch (id) {
    case "image":
      return <Image size={14} />;
    case "folder":
      return <Folder size={14} />;
    case "skill":
      return <Sparkles size={14} />;
    case "file":
      return <File size={14} />;
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

export function MentionMatchText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {matchHighlightSegments(text, query).map((segment, index) =>
        segment.hit ? <mark key={index}>{segment.text}</mark> : <React.Fragment key={index}>{segment.text}</React.Fragment>,
      )}
    </>
  );
}

export function renderPromptHighlights(value: string, files: ChatAttachment[], skills: SkillInfo[]): React.ReactNode[] {
  const segments = promptHighlightSegments(value, [
    "@image",
    ...files.map(normalizeAttachment).map(attachmentMention),
    ...skills.map(skillMention),
  ]);
  return segments.map((segment, highlightIndex) =>
    segment.mention ? (
      <span className="promptMentionToken" key={`${highlightIndex}-${segment.text}`}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}
