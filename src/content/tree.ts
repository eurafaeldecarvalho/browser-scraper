import { parse as parseHtml, type HTMLElement as ParsedElement, type Node as ParsedNode } from "node-html-parser";

// A tiny, source-agnostic DOM tree the content pipeline (markdown, metadata)
// works on. Two producers feed it:
//   * fromCdpNode — the CDP DOM.getDocument({ pierce: true }) tree. No page JS
//     runs, and the tree already contains CLOSED shadow roots and same-process
//     iframe documents; out-of-process iframe documents are spliced in by the
//     caller through `frames`. Shadow trees are COMPOSED here (slots replaced by
//     their assigned light-DOM nodes), so the output reads like what a user sees.
//   * fromHtml — a plain HTML string (the HTTP tier, no browser at all).
export type ContentNode = ContentElement | ContentText;

export type ContentElement = {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: ContentNode[];
};

export type ContentText = { type: "text"; text: string };

type CdpNode = Record<string, any>;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const DOCUMENT_NODE = 9;
const FRAGMENT_NODE = 11;

// `frames` maps an out-of-process iframe's frameId (== its CDP targetId) to the
// raw DOM.getDocument root fetched over that frame's own session. With
// `iframes: false` no frame content (same- or out-of-process) is included.
export type CdpTreeOptions = { frames?: Map<string, CdpNode>; iframes?: boolean };

type CdpContext = { frames: Map<string, CdpNode>; iframes: boolean; depth: number };

export function fromCdpNode(root: CdpNode, options: CdpTreeOptions = {}): ContentElement {
  const ctx: CdpContext = { frames: options.frames ?? new Map(), iframes: options.iframes ?? true, depth: 0 };
  return { type: "element", tag: "#document", attrs: {}, children: convert_list(root.children ?? [], ctx, null) };
}

// `host_light` carries the light-DOM children of the shadow host whose shadow
// tree is being converted, so <slot> elements can be replaced by what is
// assigned to them.
function convert_cdp(node: CdpNode, ctx: CdpContext, host_light: CdpNode[] | null): ContentNode[] | null {
  const type = Number(node.nodeType ?? 0);

  if (type === TEXT_NODE || type === CDATA_NODE) {
    return [{ type: "text", text: String(node.nodeValue ?? "") }];
  }

  if (type === DOCUMENT_NODE || type === FRAGMENT_NODE) {
    return convert_list(node.children ?? [], ctx, host_light);
  }

  if (type !== ELEMENT_NODE) {
    return null;
  }

  const tag = String(node.localName || node.nodeName || "").toLowerCase();
  const attrs = attr_map(node.attributes);

  if (tag === "slot" && host_light) {
    const name = attrs.name ?? "";
    const assigned = host_light.filter((child) => {
      const child_type = Number(child.nodeType ?? 0);
      if (child_type !== ELEMENT_NODE) {
        // Text nodes only go to the default slot.
        return name === "" && child_type === TEXT_NODE;
      }
      return (attr_map(child.attributes).slot ?? "") === name;
    });
    if (assigned.length > 0) {
      // Assigned nodes belong to the OUTER tree: their own slots resolve against
      // the outer host, not this one — conservatively stop slot resolution.
      return convert_list(assigned, ctx, null);
    }
    return convert_list(node.children ?? [], ctx, host_light);
  }

  let children: ContentNode[];
  const shadow = pick_shadow_root(node);

  if (tag === "iframe" || tag === "frame") {
    // Same-process frames are inline in the pierced tree (contentDocument);
    // out-of-process ones were fetched over their own session into ctx.frames.
    const frame_doc = node.contentDocument ?? (node.frameId ? ctx.frames.get(String(node.frameId)) : undefined);
    children = ctx.iframes && frame_doc && ctx.depth < 4 ? convert_cdp(frame_doc, { ...ctx, depth: ctx.depth + 1 }, null) ?? [] : [];
  } else if (shadow) {
    // Render the COMPOSED tree: the shadow tree, with slots pulling light DOM in.
    children = convert_list(shadow.children ?? [], ctx, node.children ?? []);
  } else {
    children = convert_list(node.children ?? [], ctx, host_light);
  }

  return [{ type: "element", tag, attrs, children }];
}

function convert_list(nodes: CdpNode[], ctx: CdpContext, host_light: CdpNode[] | null): ContentNode[] {
  const out: ContentNode[] = [];
  for (const child of nodes) {
    const converted = convert_cdp(child, ctx, host_light);
    if (converted) {
      out.push(...converted);
    }
  }
  return out;
}

// Author shadow roots (open AND closed). "user-agent" roots are the browser's own
// internals for <input>, <video>, <details>… and would only duplicate content.
function pick_shadow_root(node: CdpNode): CdpNode | null {
  for (const root of node.shadowRoots ?? []) {
    if (String(root.shadowRootType ?? "open") !== "user-agent") {
      return root;
    }
  }
  return null;
}

function attr_map(flat: unknown): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (Array.isArray(flat)) {
    for (let index = 0; index + 1 < flat.length; index += 2) {
      attrs[String(flat[index]).toLowerCase()] = String(flat[index + 1]);
    }
  }
  return attrs;
}

export function fromHtml(html: string): ContentElement {
  const root = parseHtml(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true },
  });
  return { type: "element", tag: "#document", attrs: {}, children: convert_parsed_children(root) };
}

function convert_parsed_children(node: ParsedNode): ContentNode[] {
  const out: ContentNode[] = [];
  for (const child of node.childNodes) {
    const converted = convert_parsed(child);
    if (converted) {
      out.push(converted);
    }
  }
  return out;
}

function convert_parsed(node: ParsedNode): ContentNode | null {
  // node-html-parser NodeType: 1 element, 3 text, 8 comment.
  if (node.nodeType === TEXT_NODE) {
    const raw = (node as unknown as { rawText: string }).rawText;
    return { type: "text", text: decode_entities(raw) };
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return null;
  }
  const element = node as ParsedElement;
  const tag = String(element.rawTagName ?? "").toLowerCase();
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.attributes)) {
    attrs[key.toLowerCase()] = String(value);
  }

  // Raw-text elements keep their content as one text node.
  if (tag === "script" || tag === "style" || tag === "pre" || tag === "textarea" || tag === "noscript") {
    if (tag === "pre") {
      // <pre> may still contain markup (<code>); re-parse its inner HTML.
      const inner = parseHtml(element.innerHTML, { lowerCaseTagName: true, comment: false });
      return { type: "element", tag, attrs, children: convert_parsed_children(inner) };
    }
    return { type: "element", tag, attrs, children: [{ type: "text", text: element.rawText }] };
  }

  return { type: "element", tag, attrs, children: convert_parsed_children(element) };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
};

export function decode_entities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---- small tree helpers shared by markdown + metadata ----

export function walk(node: ContentNode, visit: (element: ContentElement) => boolean | void): void {
  if (node.type !== "element") {
    return;
  }
  if (visit(node) === false) {
    return;
  }
  for (const child of node.children) {
    walk(child, visit);
  }
}

export function findFirst(node: ContentNode, predicate: (element: ContentElement) => boolean): ContentElement | null {
  let found: ContentElement | null = null;
  walk(node, (element) => {
    if (found) {
      return false;
    }
    if (predicate(element)) {
      found = element;
      return false;
    }
    return true;
  });
  return found;
}

export function findAll(node: ContentNode, predicate: (element: ContentElement) => boolean): ContentElement[] {
  const found: ContentElement[] = [];
  walk(node, (element) => {
    if (predicate(element)) {
      found.push(element);
    }
  });
  return found;
}

export function textOf(node: ContentNode): string {
  if (node.type === "text") {
    return node.text;
  }
  if (node.tag === "script" || node.tag === "style" || node.tag === "template") {
    return "";
  }
  return node.children.map(textOf).join("");
}
