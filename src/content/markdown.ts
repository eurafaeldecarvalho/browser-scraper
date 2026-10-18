import { findAll, findFirst, fromHtml, textOf, type ContentElement, type ContentNode } from "./tree";

export type MarkdownOptions = {
  // Keep only the main content: prefer <main>/<article>/[role=main] and drop
  // navigation, headers, footers, sidebars, cookie banners and similar chrome.
  // Heuristic (not Readability-grade) — set false to convert the whole body.
  mainContent?: boolean;
  // How links are rendered: "inline" [text](url) (default), "reference"
  // [text][n] with a numbered list at the end (shorter for link-heavy pages), or
  // "none" (just the text — cheapest for LLMs; the URLs are still returned in
  // `links`).
  links?: "inline" | "reference" | "none";
  // Drop images entirely (default false: ![alt](src)).
  images?: boolean;
  // Keep only the blocks relevant to this query (BM25 over paragraphs/sections,
  // headings preserved for context). Cuts tokens on long pages.
  query?: string;
  // Base URL used to resolve relative links and images.
  baseUrl?: string;
};

export type MarkdownResult = {
  markdown: string;
  title: string;
  wordCount: number;
  links: Array<{ text: string; href: string }>;
};

const SKIP_TAGS = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "map",
  "object",
  "embed",
  "audio",
  "video",
  "source",
  "track",
  "input",
  "select",
  "option",
  "textarea",
  "button",
  "dialog",
  "meta",
  "link",
  "base",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "body",
  "center",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "html",
  "iframe",
  "legend",
  "main",
  "nav",
  "section",
  "summary",
  "#document",
]);

const BOILERPLATE_TAGS = new Set(["nav", "header", "footer", "aside", "form"]);
const BOILERPLATE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog"]);
const BOILERPLATE_HINT =
  /(^|[\s_-])(nav|navbar|menu|footer|sidebar|side-bar|cookie|consent|gdpr|banner|breadcrumbs?|share|sharing|social|related|recommend|comments?|advert|ads?|sponsor|promo|newsletter|subscribe|popup|modal|overlay|toolbar|skip-link)([\s_-]|$)/i;

export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): MarkdownResult {
  return treeToMarkdown(fromHtml(html), options);
}

export function treeToMarkdown(root: ContentElement, options: MarkdownOptions = {}): MarkdownResult {
  const title = textOf(findFirst(root, (el) => el.tag === "title") ?? { type: "text", text: "" }).trim();
  const body = findFirst(root, (el) => el.tag === "body") ?? root;
  const scope = options.mainContent ?? true ? pick_main(body) : body;

  const ctx: RenderContext = {
    options,
    links: [],
    references: [],
    mainContent: options.mainContent ?? true,
  };

  let markdown = tidy(render_block_children(scope, ctx, 0));

  if (options.query && options.query.trim()) {
    markdown = filter_by_query(markdown, options.query);
  }

  if (ctx.references.length > 0 && (options.links ?? "inline") === "reference") {
    markdown += "\n\n" + ctx.references.map((href, index) => `[${index + 1}]: ${href}`).join("\n");
  }

  const words = markdown.replace(/[#>*_`|\-\[\]()!]/g, " ").split(/\s+/).filter(Boolean);
  return { markdown: markdown.trim(), title, wordCount: words.length, links: ctx.links };
}

type RenderContext = {
  options: MarkdownOptions;
  links: Array<{ text: string; href: string }>;
  references: string[];
  mainContent: boolean;
};

// ---------- main-content selection ----------

function pick_main(body: ContentElement): ContentElement {
  const main = findFirst(body, (el) => el.tag === "main" || el.attrs.role === "main");
  if (main && text_length(main) > 200) {
    return main;
  }
  const articles = findAll(body, (el) => el.tag === "article");
  if (articles.length === 1 && text_length(articles[0]) > 200) {
    return articles[0];
  }
  return body;
}

function text_length(node: ContentNode): number {
  return textOf(node).replace(/\s+/g, " ").trim().length;
}

function is_hidden(el: ContentElement): boolean {
  const attrs = el.attrs;
  if ("hidden" in attrs || attrs["aria-hidden"] === "true") {
    return true;
  }
  const style = (attrs.style ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function is_boilerplate(el: ContentElement): boolean {
  if (el.tag === "header") {
    // A <header> holding the page/article title (<h1>) is content, not chrome.
    return !findFirst(el, (child) => child.tag === "h1") || link_density(el) > 0.5;
  }
  if (BOILERPLATE_TAGS.has(el.tag)) {
    return true;
  }
  if (el.attrs.role && BOILERPLATE_ROLES.has(el.attrs.role)) {
    return true;
  }
  const hint = `${el.attrs.id ?? ""} ${el.attrs.class ?? ""}`;
  if (hint.trim() && BOILERPLATE_HINT.test(hint)) {
    // Never drop a large text container just because of a class name like
    // "content-with-sidebar": only small-ish, link-heavy or short blocks go.
    const length = text_length(el);
    if (length < 600 || link_density(el) > 0.5) {
      return true;
    }
  }
  return false;
}

function link_density(el: ContentElement): number {
  const total = text_length(el);
  if (total === 0) {
    return 0;
  }
  const linked = findAll(el, (child) => child.tag === "a").reduce((sum, a) => sum + text_length(a), 0);
  return linked / total;
}

// ---------- rendering ----------

function render_block_children(el: ContentElement, ctx: RenderContext, depth: number): string {
  let out = "";
  let inline_run = "";
  let previous_was_element = false;

  const flush = (): void => {
    const text = inline_run.replace(/[ \t\n]+/g, " ").trim();
    if (text) {
      out += `\n\n${text}\n\n`;
    }
    inline_run = "";
  };

  for (const child of el.children) {
    if (child.type === "text") {
      inline_run += child.text;
      previous_was_element = false;
      continue;
    }
    if (should_skip(child, ctx)) {
      continue;
    }
    if (is_block(child)) {
      flush();
      out += render_block(child, ctx, depth);
      previous_was_element = false;
    } else {
      const rendered = render_inline(child, ctx);
      // Same word-boundary rule as inline_raw.
      if (previous_was_element && /\S$/.test(inline_run) && /^[^\s.,;:!?)]/.test(rendered)) {
        inline_run += " ";
      }
      inline_run += rendered;
      previous_was_element = true;
    }
  }
  flush();
  return out;
}

function should_skip(el: ContentElement, ctx: RenderContext): boolean {
  if (SKIP_TAGS.has(el.tag) || is_hidden(el)) {
    return true;
  }
  if (el.tag === "img" && ctx.options.images === false) {
    return true;
  }
  return ctx.mainContent && is_boilerplate(el);
}

function is_block(el: ContentElement): boolean {
  return (
    BLOCK_TAGS.has(el.tag) ||
    /^h[1-6]$/.test(el.tag) ||
    ["p", "ul", "ol", "li", "pre", "blockquote", "table", "hr", "br"].includes(el.tag) ||
    // Unknown custom elements (web components) default to block: they usually
    // wrap whole cards/sections, and blocks keep their text from gluing.
    (el.tag.includes("-") && el.children.some((child) => child.type === "element" && is_block(child)))
  );
}

function render_block(el: ContentElement, ctx: RenderContext, depth: number): string {
  const tag = el.tag;

  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const text = inline_text(el, ctx);
    return text ? `\n\n${"#".repeat(Number(heading[1]))} ${text}\n\n` : "";
  }

  switch (tag) {
    case "p": {
      const text = inline_text(el, ctx);
      return text ? `\n\n${text}\n\n` : "";
    }
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "pre":
      return render_pre(el);
    case "blockquote": {
      const inner = tidy(render_block_children(el, ctx, depth));
      return inner ? `\n\n${inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n` : "";
    }
    case "ul":
    case "ol":
      return `\n\n${render_list(el, ctx, depth)}\n\n`;
    case "li":
      // A stray <li> outside a list.
      return `\n\n- ${inline_text(el, ctx)}\n\n`;
    case "table":
      return render_table(el, ctx);
    case "dt": {
      const text = inline_text(el, ctx);
      return text ? `\n\n**${text}**\n` : "";
    }
    case "dd": {
      const text = inline_text(el, ctx);
      return text ? `${text}\n\n` : "";
    }
    case "iframe":
      return render_block_children(el, ctx, depth);
    default:
      return render_block_children(el, ctx, depth);
  }
}

function render_pre(el: ContentElement): string {
  const code = findFirst(el, (child) => child.tag === "code");
  const lang = /(?:lang|language)-([\w+#-]+)/.exec(`${code?.attrs.class ?? ""} ${el.attrs.class ?? ""}`)?.[1] ?? "";
  const text = textOf(el).replace(/\n+$/, "");
  if (!text.trim()) {
    return "";
  }
  const fence = text.includes("```") ? "~~~" : "```";
  return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
}

function render_list(el: ContentElement, ctx: RenderContext, depth: number): string {
  const ordered = el.tag === "ol";
  let index = Number(el.attrs.start ?? 1) || 1;
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const child of el.children) {
    if (child.type !== "element" || child.tag !== "li" || should_skip(child, ctx)) {
      continue;
    }
    const marker = ordered ? `${index}.` : "-";
    index += 1;

    const own: ContentElement = { ...child, children: child.children.filter((c) => !(c.type === "element" && (c.tag === "ul" || c.tag === "ol"))) };
    const nested = child.children.filter((c): c is ContentElement => c.type === "element" && (c.tag === "ul" || c.tag === "ol"));

    const body = tidy(render_block_children(own, ctx, depth + 1)).replace(/\n{2,}/g, "\n").split("\n").join(`\n${indent}  `);
    lines.push(`${indent}${marker} ${body}`.trimEnd());
    for (const list of nested) {
      lines.push(render_list(list, ctx, depth + 1));
    }
  }
  return lines.join("\n");
}

const LAYOUT_CELL_CONTENT = new Set(["table", "div", "p", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "blockquote", "pre"]);

function render_table(el: ContentElement, ctx: RenderContext, depth = 0): string {
  // This table's OWN rows (directly or via thead/tbody/tfoot) — never the rows of
  // a table nested inside a cell, or nested content would be emitted twice.
  const rows: ContentElement[] = [];
  for (const child of el.children) {
    if (child.type !== "element") {
      continue;
    }
    if (child.tag === "tr") {
      rows.push(child);
    } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
      rows.push(...child.children.filter((row): row is ContentElement => row.type === "element" && row.tag === "tr"));
    }
  }
  if (rows.length === 0) {
    return render_block_children(el, ctx, depth);
  }

  const cells = rows.map((row) =>
    row.children.filter((cell): cell is ContentElement => cell.type === "element" && (cell.tag === "td" || cell.tag === "th") && !should_skip(cell, ctx)),
  );

  // Layout tables (old-school page structure, e.g. Hacker News) hold blocks or
  // other tables in their cells: render the cells as a sequence of blocks.
  const is_layout =
    el.attrs.role === "presentation" ||
    cells.some((row) => row.some((cell) => findFirst(cell, (inner) => inner !== cell && LAYOUT_CELL_CONTENT.has(inner.tag)) !== null));
  if (is_layout) {
    return cells.map((row) => row.map((cell) => render_block_children(cell, ctx, depth)).join("")).join("");
  }

  const matrix = cells.map((row) => row.map((cell) => inline_text(cell, ctx).replace(/\|/g, "\\|")));
  // Drop spacer rows (all cells empty).
  for (let index = matrix.length - 1; index > 0; index -= 1) {
    if (matrix[index].every((value) => !value)) {
      matrix.splice(index, 1);
    }
  }
  const width = Math.max(...matrix.map((row) => row.length));
  if (width === 0) {
    return "";
  }
  // A single row is a layout strip (menus, toolbars), not data.
  if (matrix.length === 1) {
    const text = matrix[0].filter(Boolean).join(" ").replace(/\\\|/g, "|");
    return text ? `\n\n${text}\n\n` : "";
  }
  // Layout tables (one column) read better as plain blocks.
  if (width === 1) {
    return `\n\n${matrix.map((row) => row[0]).filter(Boolean).join("\n\n")}\n\n`;
  }

  const pad = (row: string[]): string[] => [...row, ...Array(width - row.length).fill("")];
  const [head, ...rest] = matrix;
  const lines = [`| ${pad(head).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...rest.map((row) => `| ${pad(row).join(" | ")} |`)];
  return `\n\n${lines.join("\n")}\n\n`;
}

function inline_text(el: ContentElement, ctx: RenderContext): string {
  return inline_raw(el, ctx).replace(/\s+/g, " ").trim();
}

// Inline content with edge whitespace preserved (collapsed to one space), so
// "<b>foo </b>bar" keeps its word boundary.
function inline_raw(el: ContentElement, ctx: RenderContext): string {
  let out = "";
  let previous_was_element = false;
  for (const child of el.children) {
    if (child.type === "text") {
      out += child.text;
      previous_was_element = false;
    } else if (!should_skip(child, ctx)) {
      const rendered = is_block(child) && child.tag !== "br" ? ` ${inline_text(child, ctx)} ` : render_inline(child, ctx);
      // Adjacent inline elements with no whitespace between them in the source
      // ("<span>$10</span><span>In stock</span>") are usually separate values
      // laid out by CSS; keep a word boundary so they don't fuse into one token.
      if (previous_was_element && /\S$/.test(out) && /^[^\s.,;:!?)]/.test(rendered)) {
        out += " ";
      }
      out += rendered;
      previous_was_element = true;
    }
  }
  return out;
}

function wrap(el: ContentElement, ctx: RenderContext, open: string, close: string = open): string {
  const raw = inline_raw(el, ctx).replace(/\s+/g, " ");
  const text = raw.trim();
  if (!text) {
    return raw ? " " : "";
  }
  const lead = raw.startsWith(" ") ? " " : "";
  const trail = raw.endsWith(" ") ? " " : "";
  return `${lead}${open}${text}${close}${trail}`;
}

function render_inline(el: ContentElement, ctx: RenderContext): string {
  switch (el.tag) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return wrap(el, ctx, "**");
    case "em":
    case "i":
      return wrap(el, ctx, "*");
    case "del":
    case "s":
    case "strike":
      return wrap(el, ctx, "~~");
    case "code": {
      const text = textOf(el).replace(/\s+/g, " ");
      if (!text.trim()) {
        return "";
      }
      const tick = text.includes("`") ? "``" : "`";
      return `${tick}${text}${tick}`;
    }
    case "a":
      return render_link(el, ctx);
    case "img":
      return render_image(el, ctx);
    default:
      return wrap(el, ctx, "");
  }
}

function render_link(el: ContentElement, ctx: RenderContext): string {
  const text = inline_text(el, ctx);
  const raw = el.attrs.href ?? "";
  if (!raw || raw.startsWith("javascript:")) {
    return text;
  }
  const href = resolve_url(raw, ctx.options.baseUrl);
  if (text) {
    ctx.links.push({ text, href });
  }
  if (!text) {
    return "";
  }
  if (raw.startsWith("#")) {
    return text;
  }
  const mode = ctx.options.links ?? "inline";
  if (mode === "none") {
    return text;
  }
  if (mode === "reference") {
    let index = ctx.references.indexOf(href);
    if (index === -1) {
      ctx.references.push(href);
      index = ctx.references.length - 1;
    }
    return `[${text}][${index + 1}]`;
  }
  return `[${text}](${href})`;
}

function render_image(el: ContentElement, ctx: RenderContext): string {
  const src = el.attrs.src || el.attrs["data-src"] || "";
  if (!src || src.startsWith("data:")) {
    return el.attrs.alt ? el.attrs.alt : "";
  }
  return `![${(el.attrs.alt ?? "").replace(/[\[\]]/g, "")}](${resolve_url(src, ctx.options.baseUrl)})`;
}

function resolve_url(href: string, base: string | undefined): string {
  if (!base) {
    return href;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function tidy(markdown: string): string {
  return markdown
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- relevance filter (BM25 over blocks) ----------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

export function filter_by_query(markdown: string, query: string): string {
  const blocks = markdown.split(/\n{2,}/);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || blocks.length < 3) {
    return markdown;
  }

  const docs = blocks.map(tokenize);
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.includes(term)).length]));
  const k1 = 1.5;
  const b = 0.75;

  const scores = docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const tf = doc.filter((token) => token === term).length;
      if (!tf) {
        continue;
      }
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avg)));
    }
    return score;
  });

  const max = Math.max(...scores);
  if (max <= 0) {
    return markdown;
  }

  // Keep relevant blocks plus the nearest preceding heading for context.
  const keep = new Set<number>();
  scores.forEach((score, index) => {
    if (score >= max * 0.3) {
      keep.add(index);
      for (let back = index - 1; back >= 0; back -= 1) {
        if (/^#{1,6} /.test(blocks[back])) {
          keep.add(back);
          break;
        }
      }
    }
  });

  return blocks.filter((_, index) => keep.has(index)).join("\n\n");
}
