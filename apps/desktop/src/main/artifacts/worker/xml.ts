/**
 * The XML layer every OOXML engine sits on.
 *
 * Two directions, kept apart on purpose. Writing goes through `element`, which
 * builds a small tree and serialises it with escaping applied exactly once, so
 * a caller cannot forget to escape a title and cannot double-escape one that
 * came back from a parse. Reading goes through `parseXml`, which hands back a
 * DOM with external entities refused — an untrusted .pptx is a zip full of XML
 * from a stranger, and entity expansion is the classic way that becomes a
 * memory exhaustion.
 */

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export type XmlAttributes = Record<string, string | number | undefined>;

export type XmlNode =
  | { kind: "element"; name: string; attributes: XmlAttributes; children: XmlNode[] }
  | { kind: "text"; text: string }
  /** Already-serialised XML, spliced in verbatim. */
  | { kind: "raw"; xml: string };

export function element(
  name: string,
  attributes: XmlAttributes = {},
  children: Array<XmlNode | string | undefined | null> = [],
): XmlNode {
  return {
    kind: "element",
    name,
    attributes,
    children: children
      .filter((child): child is XmlNode | string => child !== undefined && child !== null)
      .map((child) => (typeof child === "string" ? { kind: "text" as const, text: child } : child)),
  };
}

export function raw(xml: string): XmlNode {
  return { kind: "raw", xml };
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

const forbiddenXmlCharacters = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
  "g",
);

/**
 * Strips the characters XML 1.0 cannot represent at all.
 *
 * A control byte that reaches a slide part makes the whole package unopenable
 * in PowerPoint, and the model has no way to know it pasted one. Dropping them
 * here is the only place that can be guaranteed to run for every string.
 */
export function sanitizeXmlText(value: string): string {
  return value.replace(forbiddenXmlCharacters, "");
}

export function serializeXml(node: XmlNode): string {
  if (node.kind === "raw") return node.xml;
  if (node.kind === "text") return escapeXmlText(sanitizeXmlText(node.text));
  const attributes = Object.entries(node.attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(sanitizeXmlText(String(value)))}"`)
    .join("");
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  const inner = node.children.map(serializeXml).join("");
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

/** A complete part: declaration plus one root element. */
export function serializeDocument(root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${serializeXml(root)}`;
}

export class XmlParseError extends Error {}

/**
 * Parses one part of a package that may have come from anywhere.
 *
 * `onError` throwing rather than warning is deliberate: a slide that half
 * parses is worse than one that fails, because the half that survived would be
 * written back over the user's file with the rest silently missing.
 */
export function parseXml(xml: string): Document {
  if (/<!ENTITY/i.test(xml) || /<!DOCTYPE/i.test(xml)) {
    throw new XmlParseError("XML declares a DOCTYPE or entity, which is refused.");
  }
  let failure: string | undefined;
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") failure ??= message;
    },
  });
  const document = parser.parseFromString(xml, "text/xml") as unknown as Document;
  if (failure) throw new XmlParseError(failure);
  if (!document.documentElement) throw new XmlParseError("XML has no root element.");
  return document;
}

export function serializeDom(document: Document | Element): string {
  return new XMLSerializer().serializeToString(document as never);
}

/** Every descendant with this local name, namespace prefix ignored. */
export function findElements(scope: Document | Element, localName: string): Element[] {
  const found: Element[] = [];
  const visit = (node: Element) => {
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (!child || child.nodeType !== 1) continue;
      const child_ = child as unknown as Element;
      if (localNameOf(child_) === localName) found.push(child_);
      visit(child_);
    }
  };
  const root = "documentElement" in scope ? scope.documentElement : scope;
  if (!root) return found;
  if (localNameOf(root as Element) === localName) found.push(root as Element);
  visit(root as Element);
  return found;
}

export function firstElement(scope: Document | Element, localName: string): Element | undefined {
  return findElements(scope, localName)[0];
}

export function localNameOf(node: Element): string {
  const name = node.nodeName ?? "";
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

export function childElements(node: Element): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    if (child && child.nodeType === 1) children.push(child as unknown as Element);
  }
  return children;
}

export function attribute(node: Element | undefined, name: string): string | undefined {
  if (!node) return undefined;
  const direct = node.getAttribute(name);
  if (direct !== null && direct !== undefined) return direct;
  // Attribute lookups in OOXML are constantly defeated by prefixes: r:id on one
  // part is id on another depending on how the producer wrote it.
  for (let index = 0; index < node.attributes.length; index += 1) {
    const candidate = node.attributes[index];
    if (!candidate) continue;
    const localName = candidate.name.includes(":")
      ? candidate.name.slice(candidate.name.indexOf(":") + 1)
      : candidate.name;
    if (localName === name) return candidate.value;
  }
  return undefined;
}

/** All text under a node, in document order, with no separators invented. */
export function textOf(node: Element | undefined): string {
  if (!node) return "";
  let text = "";
  const visit = (current: Element) => {
    for (let index = 0; index < current.childNodes.length; index += 1) {
      const child = current.childNodes[index];
      if (!child) continue;
      if (child.nodeType === 3) text += child.nodeValue ?? "";
      else if (child.nodeType === 1) visit(child as unknown as Element);
    }
  };
  visit(node);
  return text;
}
