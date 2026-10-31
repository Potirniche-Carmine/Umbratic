/**
 * Editing a .docx.
 *
 * The interesting op is `replaceText` with `tracked: true`, because a redline
 * is not a text change — it is a pair of revision marks that Word shows as an
 * insertion beside a strikethrough, and that a reviewer can accept or reject.
 * Writing that correctly is most of this module: the original run becomes a
 * `w:del` with `w:delText`, the replacement becomes a `w:ins`, and both carry
 * the author and date a reviewer sees in the margin.
 *
 * Everything else follows the same rules as the PPTX editor: only the parts an
 * op touched are rewritten, a batch is applied to a clone so a failure discards
 * all of it, and an op the surface does not allow is refused rather than
 * approximated.
 */

import { inlineRuns } from "../inlineText.js";
import { OoxmlPackage } from "../package.js";
import {
  nextRelationshipId,
  readContentTypes,
  readRelationships,
  relationshipTypes,
  writeContentTypes,
  writeRelationships,
} from "../opc.js";
import {
  attribute,
  childElements,
  element,
  findElements,
  firstElement,
  localNameOf,
  parseXml,
  serializeDom,
  serializeXml,
  textOf,
} from "../xml.js";
import { paragraphNode, runNode, wordNamespace } from "./create.js";
import { paragraphText, type DocxInspection } from "./inspect.js";

export type OpError = { path: string; message: string };

export type DocxEditResult =
  | { ok: true; pack: OoxmlPackage; applied: string[] }
  | { ok: false; errors: OpError[] };

const surgicalOps = new Set([
  "replaceText",
  "addComment",
  "fillPlaceholders",
  "setMetadata",
  "insertAfter",
  "deleteBlock",
]);

const fullOnlyOps = new Set(["replaceBlock", "setHeading", "acceptAllChanges", "rejectAllChanges"]);

export type DocxEditOptions = {
  pack: OoxmlPackage;
  inspection: DocxInspection;
  ops: unknown[];
  /** Applied to tracked changes and comments. */
  author: string;
  /** Supplied rather than read from the clock, so an edit is reproducible. */
  timestamp: string;
};

export function applyDocxOps(options: DocxEditOptions): DocxEditResult {
  const { inspection } = options;
  if (inspection.editSurface === "inspect-only") {
    return {
      ok: false,
      errors: [
        {
          path: "ops[0]",
          message: `editSurface is inspect-only (${inspection.unsupported.map((entry) => entry.kind).join(", ") || "unreadable"})`,
        },
      ],
    };
  }
  const pack = options.pack.clone();
  const errors: OpError[] = [];
  const applied: string[] = [];

  options.ops.forEach((raw, index) => {
    if (errors.length > 0) return;
    const opPath = `ops[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push({ path: opPath, message: "must be an object with an op field" });
      return;
    }
    const op = raw as Record<string, unknown>;
    const kind = typeof op.op === "string" ? op.op : "";
    if (!surgicalOps.has(kind) && !fullOnlyOps.has(kind)) {
      errors.push({
        path: `${opPath}.op`,
        message: `${kind || "(missing)"} is not an operation; use one of ${[...surgicalOps, ...fullOnlyOps].sort().join(", ")}`,
      });
      return;
    }
    if (fullOnlyOps.has(kind) && inspection.editSurface !== "full") {
      errors.push({
        path: `${opPath}.op`,
        message: `${kind} needs a full edit surface; this file is surgical (${inspection.unsupported.map((entry) => entry.kind).join(", ") || "foreign origin"})`,
      });
      return;
    }
    try {
      applied.push(applyOne(pack, kind, op, opPath, options));
    } catch (error) {
      errors.push({ path: opPath, message: String(error instanceof Error ? error.message : error) });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, pack, applied };
}

function applyOne(
  pack: OoxmlPackage,
  kind: string,
  op: Record<string, unknown>,
  opPath: string,
  options: DocxEditOptions,
): string {
  switch (kind) {
    case "replaceText":
      return replaceText(pack, op, opPath, options);
    case "fillPlaceholders":
      return fillPlaceholders(pack, op, opPath, options);
    case "addComment":
      return addComment(pack, op, opPath, options);
    case "setMetadata":
      return setMetadata(pack, op, opPath);
    case "insertAfter":
      return insertAfter(pack, op, opPath);
    case "deleteBlock":
      return deleteBlock(pack, op, opPath);
    case "replaceBlock":
      return replaceBlock(pack, op, opPath);
    case "setHeading":
      return setHeading(pack, op, opPath);
    case "acceptAllChanges":
      return resolveChanges(pack, true);
    case "rejectAllChanges":
      return resolveChanges(pack, false);
    default:
      throw new Error(`${kind} is not implemented`);
  }
}

function documentOf(pack: OoxmlPackage): Document {
  const xml = pack.text("word/document.xml");
  if (!xml) throw new Error("the document part is missing");
  return parseXml(xml);
}

function save(pack: OoxmlPackage, document: Document): void {
  pack.set("word/document.xml", serializeDom(document));
}

function requiredText(op: Record<string, unknown>, field: string, opPath: string): string {
  const value = op[field];
  if (typeof value !== "string") throw new Error(`${opPath}.${field} must be a string`);
  return value;
}

/**
 * Finds the paragraphs an op addresses.
 *
 * Scope is a block id from inspect, or absent for the whole document. Ids that
 * came from a bookmark are matched on the bookmark; positional ids are matched
 * by counting, which is why inspect marks which is which.
 */
function paragraphsInScope(document: Document, scope: unknown, opPath: string): Element[] {
  const body = firstElement(document, "body");
  const all = body ? childElements(body).filter((node) => localNameOf(node) === "p") : [];
  if (scope === undefined || scope === null) return all;
  if (typeof scope !== "string") throw new Error(`${opPath}.scope must be a block id from inspect`);

  const anchored = all.filter((node) =>
    findElements(node, "bookmarkStart").some((start) => attribute(start, "name") === scope),
  );
  if (anchored.length > 0) return anchored;

  const positional = /^p(\d+)$/.exec(scope);
  if (positional) {
    const body_ = firstElement(document, "body");
    const blocks = body_ ? childElements(body_).filter((node) => localNameOf(node) !== "sectPr") : [];
    const node = blocks[Number(positional[1]) - 1];
    if (node && localNameOf(node) === "p") return [node];
    if (node) return childElements(node).filter((child) => localNameOf(child) === "p");
  }
  throw new Error(`no block with id ${scope}; call inspect and use an id from its outline`);
}

/* -------------------------------- text ops -------------------------------- */

function replaceText(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  options: DocxEditOptions,
): string {
  const find = requiredText(op, "find", opPath);
  const replace = requiredText(op, "replace", opPath);
  if (find.length === 0) throw new Error(`${opPath}.find must not be empty`);
  const tracked = op.tracked === true;
  const document = documentOf(pack);
  const replaced = replaceInParagraphs(
    document,
    paragraphsInScope(document, op.scope, opPath),
    find,
    replace,
    tracked ? { author: options.author, date: options.timestamp } : undefined,
  );
  if (replaced === 0) {
    throw new Error(`"${find}" does not appear in that scope, so nothing was changed`);
  }
  save(pack, document);
  return `replaceText ${replaced} occurrence${replaced === 1 ? "" : "s"}${tracked ? " (tracked)" : ""}`;
}

function fillPlaceholders(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  options: DocxEditOptions,
): string {
  const values = op.values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`${opPath}.values must be an object of placeholder names to strings`);
  }
  const document = documentOf(pack);
  const paragraphs = paragraphsInScope(document, undefined, opPath);
  const tracked = op.tracked === true;
  let total = 0;
  const missed: string[] = [];
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`${opPath}.values.${name} must be a string or a number`);
    }
    const replaced = replaceInParagraphs(
      document,
      paragraphs,
      `{{${name}}}`,
      String(value),
      tracked ? { author: options.author, date: options.timestamp } : undefined,
    );
    if (replaced === 0) missed.push(name);
    total += replaced;
  }
  // A placeholder that was not there is a mistake worth surfacing: it usually
  // means the model guessed the name rather than reading it off inspect.
  if (missed.length > 0) {
    throw new Error(
      `the document has no placeholder named ${missed.map((name) => `{{${name}}}`).join(", ")}; inspect reports the ones it does have`,
    );
  }
  save(pack, document);
  return `fillPlaceholders ${total} replacement${total === 1 ? "" : "s"}`;
}

/**
 * Replaces text across coalesced runs, optionally as a tracked change.
 *
 * The paragraph's runs are flattened to one string, the replacement is done on
 * that string, and the paragraph is rebuilt. Rebuilding rather than patching
 * run-by-run is what makes a match spanning three runs work at all; the cost is
 * that a paragraph's internal formatting collapses to its first run's, which is
 * why the untracked path preserves that run's properties explicitly.
 */
function replaceInParagraphs(
  document: Document,
  paragraphs: Element[],
  find: string,
  replace: string,
  tracked: { author: string; date: string } | undefined,
): number {
  let count = 0;
  for (const paragraph of paragraphs) {
    const runs = childElements(paragraph).filter((node) => localNameOf(node) === "r");
    if (runs.length === 0) continue;
    const combined = runs.map((run) => textOf(firstElement(run, "t"))).join("");
    if (!combined.includes(find)) continue;
    const occurrences = combined.split(find).length - 1;
    count += occurrences;

    const templateProperties = firstElement(runs[0]!, "rPr");
    const propertiesXml = templateProperties ? serializeDom(templateProperties) : "";

    if (!tracked) {
      const updated = combined.split(find).join(replace);
      const first = runs[0]!;
      const textNode = firstElement(first, "t");
      if (textNode) {
        while (textNode.firstChild) textNode.removeChild(textNode.firstChild);
        textNode.appendChild(document.createTextNode(updated) as never);
        textNode.setAttribute("xml:space", "preserve");
      }
      for (const run of runs.slice(1)) run.parentNode?.removeChild(run);
      continue;
    }

    // Tracked: the paragraph becomes kept text, a deletion, kept text, an
    // insertion, and so on, so a reviewer sees exactly which words moved.
    const anchor = runs[0]!;
    const parts = splitAround(combined, find);
    const rebuilt: string[] = [];
    for (const part of parts) {
      if (part.match) {
        rebuilt.push(deletionXml(part.text, propertiesXml, tracked, rebuilt.length));
        rebuilt.push(insertionXml(replace, propertiesXml, tracked, rebuilt.length));
      } else if (part.text.length > 0) {
        rebuilt.push(keptRunXml(part.text, propertiesXml));
      }
    }
    const fragment = parseXml(`<w:wrap xmlns:w="${wordNamespace}">${rebuilt.join("")}</w:wrap>`);
    for (const node of childElements(fragment.documentElement as unknown as Element)) {
      paragraph.insertBefore(document.importNode(node as unknown as Node, true) as never, anchor as never);
    }
    for (const run of runs) run.parentNode?.removeChild(run);
  }
  return count;
}

function splitAround(value: string, find: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (let at = value.indexOf(find); at !== -1; at = value.indexOf(find, cursor)) {
    if (at > cursor) parts.push({ text: value.slice(cursor, at), match: false });
    parts.push({ text: find, match: true });
    cursor = at + find.length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), match: false });
  return parts;
}

function keptRunXml(text: string, propertiesXml: string): string {
  return serializeXml(
    element("w:r", {}, [
      propertiesXml ? { kind: "raw", xml: propertiesXml } : undefined,
      element("w:t", { "xml:space": "preserve" }, [text]),
    ] as never),
  );
}

function deletionXml(
  text: string,
  propertiesXml: string,
  tracked: { author: string; date: string },
  index: number,
): string {
  // `w:delText` rather than `w:t`: a deleted run that still carries w:t is text
  // Word will show as present, which defeats the point of the revision mark.
  return serializeXml(
    element("w:del", { "w:id": 900 + index, "w:author": tracked.author, "w:date": tracked.date }, [
      element("w:r", {}, [
        propertiesXml ? { kind: "raw", xml: propertiesXml } : undefined,
        element("w:delText", { "xml:space": "preserve" }, [text]),
      ] as never),
    ]),
  );
}

function insertionXml(
  text: string,
  propertiesXml: string,
  tracked: { author: string; date: string },
  index: number,
): string {
  return serializeXml(
    element("w:ins", { "w:id": 950 + index, "w:author": tracked.author, "w:date": tracked.date }, [
      element("w:r", {}, [
        propertiesXml ? { kind: "raw", xml: propertiesXml } : undefined,
        element("w:t", { "xml:space": "preserve" }, [text]),
      ] as never),
    ]),
  );
}

/**
 * Accepts or rejects every revision in the document.
 *
 * Accepting keeps insertions and drops deletions; rejecting does the opposite.
 * Both unwrap the revision marks entirely, which is what "finalise" means — a
 * document that still carries them is still a draft.
 */
function resolveChanges(pack: OoxmlPackage, accept: boolean): string {
  const document = documentOf(pack);
  let resolved = 0;
  for (const node of [...findElements(document, "ins"), ...findElements(document, "del")]) {
    const isInsertion = localNameOf(node) === "ins";
    const keep = isInsertion ? accept : !accept;
    resolved += 1;
    if (!keep) {
      node.parentNode?.removeChild(node);
      continue;
    }
    // A kept deletion has to become ordinary text again, which means its
    // delText elements become t elements.
    for (const deleted of findElements(node, "delText")) {
      const replacement = document.createElement("w:t") as unknown as Element;
      replacement.setAttribute("xml:space", "preserve");
      replacement.appendChild(document.createTextNode(textOf(deleted)) as never);
      deleted.parentNode?.replaceChild(replacement as never, deleted as never);
    }
    while (node.firstChild) {
      node.parentNode?.insertBefore(node.firstChild as never, node as never);
    }
    node.parentNode?.removeChild(node);
  }
  if (resolved === 0) throw new Error("the document has no tracked changes to resolve");
  save(pack, document);
  return `${accept ? "acceptAllChanges" : "rejectAllChanges"} on ${resolved} revision${resolved === 1 ? "" : "s"}`;
}

/* ------------------------------- block ops -------------------------------- */

function insertAfter(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const document = documentOf(pack);
  const target = paragraphsInScope(document, requiredText(op, "after", opPath), opPath).at(-1);
  if (!target) throw new Error(`no block with id ${String(op.after)}`);
  const text = requiredText(op, "text", opPath);
  const style = typeof op.style === "string" ? op.style : "BodyText";
  const node = paragraphNode(
    inlineRuns(text).map((run) =>
      runNode(run.text, {
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italic: true } : {}),
        ...(run.code ? { code: true } : {}),
      }),
    ),
    { style },
  );
  const fragment = parseXml(`<w:wrap xmlns:w="${wordNamespace}">${serializeXml(node)}</w:wrap>`);
  const inserted = childElements(fragment.documentElement as unknown as Element)[0]!;
  target.parentNode?.insertBefore(
    document.importNode(inserted as unknown as Node, true) as never,
    target.nextSibling as never,
  );
  save(pack, document);
  return `insertAfter ${String(op.after)}`;
}

function deleteBlock(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const document = documentOf(pack);
  const id = requiredText(op, "block", opPath);
  const targets = paragraphsInScope(document, id, opPath);
  if (targets.length === 0) throw new Error(`no block with id ${id}`);
  for (const target of targets) target.parentNode?.removeChild(target);
  save(pack, document);
  return `deleteBlock ${id}`;
}

function replaceBlock(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const document = documentOf(pack);
  const id = requiredText(op, "block", opPath);
  const targets = paragraphsInScope(document, id, opPath);
  if (targets.length === 0) throw new Error(`no block with id ${id}`);
  const text = requiredText(op, "text", opPath);
  const first = targets[0]!;
  const style = attribute(firstElement(first, "pStyle"), "val") ?? "BodyText";
  const node = paragraphNode(
    inlineRuns(text).map((run) =>
      runNode(run.text, {
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italic: true } : {}),
        ...(run.code ? { code: true } : {}),
      }),
    ),
    { style, blockId: /^b\d+$/.test(id) ? id : undefined },
  );
  const fragment = parseXml(`<w:wrap xmlns:w="${wordNamespace}">${serializeXml(node)}</w:wrap>`);
  const replacement = childElements(fragment.documentElement as unknown as Element)[0]!;
  first.parentNode?.insertBefore(
    document.importNode(replacement as unknown as Node, true) as never,
    first as never,
  );
  for (const target of targets) target.parentNode?.removeChild(target);
  save(pack, document);
  return `replaceBlock ${id}`;
}

function setHeading(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const document = documentOf(pack);
  const id = requiredText(op, "block", opPath);
  const level = op.level ?? 1;
  if (level !== 1 && level !== 2 && level !== 3) throw new Error(`${opPath}.level must be 1, 2, or 3`);
  const targets = paragraphsInScope(document, id, opPath);
  if (targets.length === 0) throw new Error(`no block with id ${id}`);
  for (const target of targets) {
    let properties = firstElement(target, "pPr");
    if (!properties) {
      properties = document.createElement("w:pPr") as unknown as Element;
      target.insertBefore(properties as never, target.firstChild as never);
    }
    const existing = firstElement(properties, "pStyle");
    if (existing) existing.setAttribute("w:val", `Heading${level}`);
    else {
      const style = document.createElement("w:pStyle") as unknown as Element;
      style.setAttribute("w:val", `Heading${level}`);
      properties.insertBefore(style as never, properties.firstChild as never);
    }
  }
  save(pack, document);
  return `setHeading ${id} to level ${level}`;
}

/* -------------------------------- metadata -------------------------------- */

function setMetadata(pack: OoxmlPackage, op: Record<string, unknown>, opPath: string): string {
  const xml = pack.text("docProps/core.xml");
  if (!xml) throw new Error("the document has no core properties part");
  const document = parseXml(xml);
  const fields: Array<[string, string]> = [
    ["title", "dc:title"],
    ["author", "dc:creator"],
    ["subject", "dc:subject"],
  ];
  let changed = 0;
  for (const [field, tag] of fields) {
    const value = op[field];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${opPath}.${field} must be a string`);
    const existing = findElements(document, tag.split(":")[1]!)[0];
    if (existing) {
      while (existing.firstChild) existing.removeChild(existing.firstChild);
      existing.appendChild(document.createTextNode(value) as never);
    } else {
      const node = document.createElement(tag) as unknown as Element;
      node.appendChild(document.createTextNode(value) as never);
      document.documentElement?.appendChild(node as never);
    }
    changed += 1;
  }
  if (changed === 0) throw new Error(`${opPath} must set at least one of title, author, subject`);
  pack.set("docProps/core.xml", serializeDom(document));
  return `setMetadata (${changed} field${changed === 1 ? "" : "s"})`;
}

/* -------------------------------- comments -------------------------------- */

/**
 * Adds a comment anchored to the first occurrence of some text.
 *
 * A comment is four things: the comment body in `comments.xml`, a range start
 * and end around the text in `document.xml`, and a reference run. Missing any
 * one of them produces a document Word offers to repair, which is why they are
 * all written here rather than in whatever order an op sequence happens to run.
 */
function addComment(
  pack: OoxmlPackage,
  op: Record<string, unknown>,
  opPath: string,
  options: DocxEditOptions,
): string {
  const anchorText = requiredText(op, "on", opPath);
  const body = requiredText(op, "text", opPath);
  const document = documentOf(pack);
  const paragraph = paragraphsInScope(document, op.scope, opPath).find((node) =>
    paragraphText(node).includes(anchorText),
  );
  if (!paragraph) throw new Error(`"${anchorText}" does not appear in that scope`);

  const commentsXml = pack.text("word/comments.xml");
  const comments = commentsXml
    ? parseXml(commentsXml)
    : parseXml(`<w:comments xmlns:w="${wordNamespace}"/>`);
  const identifier = findElements(comments, "comment").length + 1;

  const fragment = parseXml(
    `<w:wrap xmlns:w="${wordNamespace}">${serializeXml(
      element("w:comment", {
        "w:id": identifier,
        "w:author": options.author,
        "w:date": options.timestamp,
        "w:initials": initialsOf(options.author),
      }, [
        paragraphNode([runNode(body)], { style: "CommentText" }),
      ]),
    )}</w:wrap>`,
  );
  comments.documentElement?.appendChild(
    comments.importNode(childElements(fragment.documentElement as unknown as Element)[0]! as unknown as Node, true) as never,
  );
  pack.set("word/comments.xml", serializeDom(comments));

  const marks = parseXml(
    `<w:wrap xmlns:w="${wordNamespace}">`
      + `<w:commentRangeStart w:id="${identifier}"/>`
      + `<w:commentRangeEnd w:id="${identifier}"/>`
      + `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${identifier}"/></w:r>`
      + `</w:wrap>`,
  );
  const [start, end, reference] = childElements(marks.documentElement as unknown as Element);
  paragraph.insertBefore(
    document.importNode(start as unknown as Node, true) as never,
    paragraph.firstChild as never,
  );
  paragraph.appendChild(document.importNode(end as unknown as Node, true) as never);
  paragraph.appendChild(document.importNode(reference as unknown as Node, true) as never);
  save(pack, document);

  if (!commentsXml) {
    const relationships = readRelationships(pack, "word/document.xml");
    writeRelationships(pack, "word/document.xml", [
      ...relationships,
      {
        id: nextRelationshipId(relationships),
        type: `${relationshipTypes.image.replace("/image", "/comments")}`,
        target: "comments.xml",
      },
    ]);
    const types = readContentTypes(pack);
    types.overrides.set(
      "/word/comments.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    );
    writeContentTypes(pack, types);
  }
  return `addComment on "${anchorText.slice(0, 40)}"`;
}

function initialsOf(author: string): string {
  return author
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join("")
    .slice(0, 4);
}
