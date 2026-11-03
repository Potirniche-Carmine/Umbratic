import React, { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { safeExternalUrl } from "../shared/externalLink";
import { localFileLink } from "../shared/localFileLink";
import {
  isEscapedMarkdownAt,
  markdownPreview,
  parseMarkdown,
  stabilizeStreamingInlineText,
  type MarkdownBlock,
} from "./composerText";
import { copyPlainText } from "./copyPlainText";
import { InlineLink, readMarkdownLink } from "./inlineLink";
import type { ReviewFile } from "./rendererTypes";
import { MermaidDiagram } from "./MermaidDiagram";
import { useSourceSyntax } from "./useSourceSyntax";
import { SourceTokens } from "./SourceTokens";
import { useStreamingText } from "./useStreamingText";

const markdownPreviewCharacterLimit = 60000;

type ReviewReferenceOptions = {
  onLocalFileClick?: (path: string, line?: number) => void;
  reviewFiles?: ReviewFile[];
  onReviewFileClick?: (filePath: string) => void;
};

export function normalizeReviewReference(value: string): string {
  return value
    .replace(/^@/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^[`"']+|[`"',.:;!?]+$/g, "")
    .trim();
}

function fileNameFromPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? value;
}

export function reviewFileForReference(value: string, reviewFiles?: ReviewFile[]): ReviewFile | undefined {
  if (!reviewFiles?.length) return undefined;
  const reference = normalizeReviewReference(value);
  if (!reference) return undefined;
  const normalizedFiles = reviewFiles.map((file) => ({ file, path: normalizeReviewReference(file.path) }));
  const exact = normalizedFiles.find(({ path }) => path === reference);
  if (exact) return exact.file;
  if (reference.includes("/")) {
    const suffix = normalizedFiles.find(({ path }) => path.endsWith(`/${reference}`));
    if (suffix) return suffix.file;
  }
  const basenameMatches = normalizedFiles.filter(({ path }) => fileNameFromPath(path) === reference);
  return basenameMatches.length === 1 ? basenameMatches[0].file : undefined;
}

function renderReferenceToken(part: string, key: string, options?: ReviewReferenceOptions): React.ReactNode {
  const reviewFile = reviewFileForReference(part, options?.reviewFiles);
  if (reviewFile && options?.onReviewFileClick) {
    return (
      <button className="inlineMentionToken reviewReferenceToken" key={key} type="button" onClick={() => options.onReviewFileClick?.(reviewFile.path)}>
        {normalizeReviewReference(part)}
      </button>
    );
  }
  if (part.startsWith("@") || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(part)) {
    return (
      <span className="inlineMentionToken" key={key}>
        {part}
      </span>
    );
  }
  return <React.Fragment key={key}>{part}</React.Fragment>;
}

function renderPlainInlineText(text: string, keyPrefix: string, options?: ReviewReferenceOptions): React.ReactNode[] {
  return text
    .split(/(@[A-Za-z0-9][A-Za-z0-9._/-]*|(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/g)
    .map((part, index) => renderReferenceToken(part, `${keyPrefix}-ref-${index}`, options));
}

function findClosingBacktickRun(text: string, startIndex: number, runLength: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] !== "`" || isEscapedMarkdownAt(text, index)) continue;
    let nextIndex = index;
    while (nextIndex < text.length && text[nextIndex] === "`") nextIndex += 1;
    if (nextIndex - index === runLength) return index;
    index = nextIndex - 1;
  }
  return -1;
}

export function codeBlockLabel(language: string, content: string): string {
  const normalized = language.trim().toLowerCase();
  if (/^(bash|sh|zsh|shell|console|terminal|powershell|ps1|pwsh|cmd|bat)$/i.test(normalized)) return normalized || "command";
  if (!normalized && looksLikeCommandBlock(content)) return "command";
  return normalized || "code";
}

export function looksLikeCommandBlock(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) =>
    /^[$>]/.test(line) ||
    /^(npm|pnpm|yarn|bun|node|git|cmake|ctest|make|ninja|python|uv|cargo|go|dotnet|winget|brew|sudo|apt-get|dnf|pacman|rg|fd|tree-sitter)\b/i.test(line),
  );
}

function MarkdownCodeBlock({
  language,
  content,
  trailingInline,
}: { language: string; content: string; trailingInline?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const label = codeBlockLabel(language, content);
  const isCommand = label === "command" || /^(bash|sh|zsh|shell|console|terminal|powershell|ps1|pwsh|cmd|bat)$/i.test(label);
  const syntax = useSourceSyntax([{ language: language || (isCommand ? label : ""), text: content }])?.[0];
  async function copyBlock() {
    await copyPlainText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <figure className={`markdownCodeBlock ${isCommand ? "isCommand" : ""}`}>
      <figcaption>
        <span>{label}</span>
        <button type="button" onClick={() => void copyBlock()} title="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre className="markdownCode">
        <code>{content.split(/(\r?\n)/).map((part, index) => index % 2 ? part : <SourceTokens key={index} text={part} tokens={syntax?.lines[index / 2]}/>)}{trailingInline ?? null}</code>
      </pre>
    </figure>
  );
}

export function renderInlineMarkdown(text: string, options?: ReviewReferenceOptions): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let plain = "";
  let keyIndex = 0;

  const flushPlain = () => {
    if (!plain) return;
    const key = `inline-${keyIndex}`;
    nodes.push(<React.Fragment key={key}>{renderPlainInlineText(plain, key, options)}</React.Fragment>);
    keyIndex += 1;
    plain = "";
  };

  const pushCode = (code: string) => {
    flushPlain();
    const key = `code-${keyIndex}`;
    keyIndex += 1;
    if (reviewFileForReference(code, options?.reviewFiles) || code.startsWith("@") || /[\\/].+\.[A-Za-z0-9]{1,8}$/.test(code)) {
      nodes.push(renderReferenceToken(code, key, options));
      return;
    }
    nodes.push(<code key={key}>{code}</code>);
  };

  const pushFormatted = (node: React.ReactNode) => {
    flushPlain();
    nodes.push(node);
    keyIndex += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && /[`*_\\]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 1;
      continue;
    }
    if (char === "`" && !isEscapedMarkdownAt(text, index)) {
      let endOfRun = index;
      while (endOfRun < text.length && text[endOfRun] === "`") endOfRun += 1;
      const runLength = endOfRun - index;
      const closingIndex = findClosingBacktickRun(text, endOfRun, runLength);
      if (closingIndex >= 0) {
        pushCode(text.slice(endOfRun, closingIndex));
        index = closingIndex + runLength - 1;
        continue;
      }
    }
    if (char === "[" && !isEscapedMarkdownAt(text, index)) {
      const link = readMarkdownLink(text, index);
      if (link) {
        const safeUrl = safeExternalUrl(link.url);
        if (safeUrl) {
          pushFormatted(
            <InlineLink href={safeUrl} key={`link-${keyIndex}`}>
              {renderInlineMarkdown(link.label, options)}
            </InlineLink>,
          );
          index = link.end;
          continue;
        }
        const file = localFileLink(link.url);
        if (file && options?.onLocalFileClick) {
          const label = file.line ? link.label.replace(new RegExp(`(?:[:#]L?${file.line}|\\s+line\\s+${file.line}|\\s*\\(${file.line}\\))$`, "i"), "") : link.label;
          pushFormatted(<button className="inlineFileLink" key={`file-${keyIndex}`} type="button" title={`${file.path}${file.line ? ` · Line ${file.line}` : ""}`} aria-label={file.line ? `${label}, line ${file.line}` : undefined}
            onClick={() => options.onLocalFileClick?.(file.path, file.line)}><span className="inlineFileName">{label}</span>{file.line && <span className="inlineFileLine">({file.line})</span>}</button>);
          index = link.end;
          continue;
        }
        // An unsafe or unparseable URL is left exactly as written. Rendering
        // just the label would hide where a hostile link points.
        plain += text.slice(index, link.end + 1);
        index = link.end;
        continue;
      }
    }
    if (text.startsWith("**", index) && !isEscapedMarkdownAt(text, index)) {
      const closingIndex = text.indexOf("**", index + 2);
      if (closingIndex > index + 2) {
        pushFormatted(<strong key={`strong-${keyIndex}`}>{text.slice(index + 2, closingIndex)}</strong>);
        index = closingIndex + 1;
        continue;
      }
    }
    if ((char === "*" || char === "_") && !isEscapedMarkdownAt(text, index)) {
      const closingIndex = text.indexOf(char, index + 1);
      if (closingIndex > index + 1 && !text.slice(index + 1, closingIndex).includes("\n")) {
        pushFormatted(<em key={`em-${keyIndex}`}>{text.slice(index + 1, closingIndex)}</em>);
        index = closingIndex;
        continue;
      }
    }
    plain += char;
  }

  flushPlain();
  return nodes;
}

function MarkdownBlockView({
  block,
  referenceOptions,
  trailingInline,
  streaming = false,
}: {
  block: MarkdownBlock;
  blockKey?: string;
  referenceOptions?: ReviewReferenceOptions;
  trailingInline?: React.ReactNode;
  streaming?: boolean;
}) {
  if (block.type === "code") {
    if (block.language.trim().toLowerCase() === "mermaid") return <MermaidDiagram content={block.content} streaming={streaming}/>;
    return <MarkdownCodeBlock content={block.content} language={block.language} trailingInline={trailingInline} />;
  }
  if (block.type === "heading") {
    const headingContent = (
      <>
        {renderInlineMarkdown(block.text, referenceOptions)}
        {trailingInline ?? null}
      </>
    );
    if (block.level === 1) return <h3>{headingContent}</h3>;
    if (block.level === 2) return <h4>{headingContent}</h4>;
    return <h5>{headingContent}</h5>;
  }
  if (block.type === "list") {
    const listItems = block.items.map((item, itemIndex) => (
      <li key={itemIndex}>
        {renderInlineMarkdown(item, referenceOptions)}
        {itemIndex === block.items.length - 1 ? trailingInline ?? null : null}
      </li>
    ));
    return block.ordered ? <ol>{listItems}</ol> : <ul>{listItems}</ul>;
  }
  if (block.type === "rule") return <hr />;
  if (block.type === "quote") {
    return <blockquote>{renderInlineMarkdown(block.text, referenceOptions)}{trailingInline ?? null}</blockquote>;
  }
  if (block.type === "table") {
    return (
      <div className="markdownTableWrapper">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex}>
                  {renderInlineMarkdown(header, referenceOptions)}
                  {block.rows.length === 0 && headerIndex === block.headers.length - 1 ? trailingInline ?? null : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {renderInlineMarkdown(cell, referenceOptions)}
                    {rowIndex === block.rows.length - 1 && cellIndex === row.length - 1 ? trailingInline ?? null : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "paragraph") {
    return (
      <p>
        {renderInlineMarkdown(block.text, referenceOptions)}
        {trailingInline ?? null}
      </p>
    );
  }
  const exhaustive: never = block;
  return exhaustive;
}

// Settled blocks never change once streamed past, so a stable serialized key
// lets every block before the live tail skip re-rendering entirely.
const MemoizedMarkdownBlockView = React.memo(
  MarkdownBlockView,
  (previous, next) => previous.blockKey === next.blockKey && previous.referenceOptions === next.referenceOptions
    && previous.streaming === next.streaming && previous.trailingInline === next.trailingInline,
);

export function MarkdownContent({
  content,
  onLocalFileClick,
  onReviewFileClick,
  reviewFiles,
  trailingInline,
  streaming = false,
  caretClassName,
}: {
  content: string;
  trailingInline?: React.ReactNode;
  streaming?: boolean;
  caretClassName?: string;
} & ReviewReferenceOptions) {
  const displayed = useStreamingText(content, streaming);
  const blocks = useMemo(() => parseMarkdown(displayed), [displayed]);
  const blockKeys = useMemo(() => blocks.map((block) => JSON.stringify(block)), [blocks]);
  const referenceOptions = useMemo(() => ({ onReviewFileClick, reviewFiles, onLocalFileClick }), [onReviewFileClick, reviewFiles, onLocalFileClick]);
  // One component for streaming and settled rendering: the flip at the end of
  // a stream is then an ordinary re-render — the caret leaves, the tail block
  // stops being stabilized — instead of a remount that rebuilds every
  // paragraph and code block in one frame.
  //
  // The caret rides at the end of the text being written — inside the code
  // box while a fence is open, in the last cell of a table — rather than on
  // its own line under the block, where it read as a cursor stranded at the
  // bottom of the message. Only a rule has nowhere to put it.
  const caret = streaming && caretClassName ? <span className={caretClassName} aria-hidden="true" /> : null;
  const lastBlock = blocks.at(-1);
  const caretInline = !!caret && !!lastBlock && lastBlock.type !== "rule";
  // Use the same component type for the live tail and completed blocks. Swapping
  // types at a paragraph boundary remounts the DOM and loses code-block state.
  // Settled blocks skip reconciliation; the tail also compares its caret and
  // streaming state so completion removes transient syntax in place.
  return (
    <div className="markdownContent">
      {blocks.map((block, index) => {
        const tail = index === blocks.length - 1;
        return (
          <MemoizedMarkdownBlockView
            key={index}
            block={tail && streaming ? stabilizedStreamingBlock(block) : block}
            blockKey={blockKeys[index]}
            referenceOptions={referenceOptions}
            streaming={tail && streaming}
            trailingInline={tail ? (caretInline ? caret : trailingInline) : undefined}
          />
        );
      })}
      {caret && !caretInline ? caret : null}
    </div>
  );
}

export function LongMarkdownContent({
  content,
  onReviewFileClick,
  reviewFiles,
  trailingInline,
  streaming = false,
  caretClassName,
}: {
  content: string;
  trailingInline?: React.ReactNode;
  streaming?: boolean;
  caretClassName?: string;
} & ReviewReferenceOptions) {
  const [expanded, setExpanded] = useState(false);
  // No preview while streaming: clamping would hide the live tail, and the
  // scan is wasted work on every flushed batch. The offer to fold a very long
  // response appears once it has finished arriving.
  const preview = useMemo(
    () => (streaming ? null : markdownPreview(content, markdownPreviewCharacterLimit)),
    [content, streaming],
  );
  const truncated = !!preview?.truncated;
  const displayContent = expanded || !truncated ? content : preview.text;
  return (
    <>
      <MarkdownContent
        content={displayContent}
        onReviewFileClick={onReviewFileClick}
        reviewFiles={reviewFiles}
        trailingInline={trailingInline}
        streaming={streaming}
        caretClassName={caretClassName}
      />
      {truncated ? (
        <div className="messageOverflowNotice">
          <span>
            Showing a preview of a long response ({content.length.toLocaleString()} characters).
          </span>
          <button type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Show preview" : "Show full response"}
          </button>
        </div>
      ) : null}
    </>
  );
}

// The live tail block re-renders as markdown with unfinished inline syntax
// stabilized first, so styling appears progressively instead of popping from
// plain text to formatted at each paragraph boundary. Everything before the
// tail is memoized per block and never re-parsed into DOM. parseMarkdown
// already renders an unterminated ``` fence as a code block, so the split is
// fence-safe by construction.
function stabilizedStreamingBlock(block: MarkdownBlock): MarkdownBlock {
  if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
    return { ...block, text: stabilizeStreamingInlineText(block.text) };
  }
  if (block.type === "list" && block.items.length) {
    const items = [...block.items];
    items[items.length - 1] = stabilizeStreamingInlineText(items[items.length - 1]);
    return { ...block, items };
  }
  return block;
}

export function AssistantAnswerContent({
  content,
  streaming,
  onReviewFileClick,
  reviewFiles,
}: {
  content: string;
  streaming: boolean;
} & ReviewReferenceOptions) {
  // The wrapper and everything inside it persist across the streaming →
  // settled flip; only props change. Settling used to swap component types
  // here, which unmounted the entire rendered answer and rebuilt it in one
  // frame — the flash at the end of every response.
  return (
    <div className={streaming ? "streamingTextContent" : undefined}>
      <LongMarkdownContent
        content={content}
        onReviewFileClick={onReviewFileClick}
        reviewFiles={reviewFiles}
        streaming={streaming}
        caretClassName="streamingTextCaret"
      />
    </div>
  );
}

export function WorkMarkdownContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className={streaming ? "workMarkdownContent isStreaming" : "workMarkdownContent"}>
      <MarkdownContent content={content} streaming={streaming} />
    </div>
  );
}
