import { findAll, findFirst, fromHtml, textOf, type ContentElement } from "./tree";

export type PageMetadata = {
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  siteName: string | null;
  author: string | null;
  publishedTime: string | null;
  image: string | null;
  favicon: string | null;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  // Every parseable <script type="application/ld+json"> block (schema.org). An
  // @graph wrapper is kept as-is; invalid JSON blocks are skipped.
  jsonLd: unknown[];
};

export function extractMetadata(html: string, baseUrl?: string): PageMetadata {
  return treeMetadata(fromHtml(html), baseUrl);
}

export function treeMetadata(root: ContentElement, baseUrl?: string): PageMetadata {
  const metas = findAll(root, (el) => el.tag === "meta");
  const named = new Map<string, string>();
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};

  for (const meta of metas) {
    const key = (meta.attrs.property || meta.attrs.name || meta.attrs.itemprop || "").toLowerCase().trim();
    const content = meta.attrs.content;
    if (!key || content == null) {
      continue;
    }
    if (key.startsWith("og:")) {
      openGraph[key.slice(3)] ??= content;
    } else if (key.startsWith("twitter:")) {
      twitter[key.slice(8)] ??= content;
    }
    if (!named.has(key)) {
      named.set(key, content);
    }
  }

  const links = findAll(root, (el) => el.tag === "link");
  const link_href = (predicate: (rel: string) => boolean): string | null => {
    const link = links.find((el) => predicate((el.attrs.rel ?? "").toLowerCase()));
    return link?.attrs.href ? resolve(link.attrs.href, baseUrl) : null;
  };

  const jsonLd: unknown[] = [];
  for (const script of findAll(root, (el) => el.tag === "script" && (el.attrs.type ?? "").toLowerCase() === "application/ld+json")) {
    try {
      jsonLd.push(JSON.parse(textOf_raw(script)));
    } catch {
      // Malformed blocks are common in the wild; skip them.
    }
  }

  const title_tag = findFirst(root, (el) => el.tag === "title");
  const html_el = findFirst(root, (el) => el.tag === "html");
  const image = openGraph.image ?? twitter.image ?? null;

  return {
    title: openGraph.title ?? (title_tag ? textOf(title_tag).trim() || null : null),
    description: named.get("description") ?? openGraph.description ?? twitter.description ?? null,
    canonical: link_href((rel) => rel.split(/\s+/).includes("canonical")) ?? openGraph.url ?? null,
    lang: html_el?.attrs.lang ?? openGraph.locale ?? null,
    siteName: openGraph.site_name ?? named.get("application-name") ?? null,
    author: named.get("author") ?? named.get("article:author") ?? null,
    publishedTime: named.get("article:published_time") ?? openGraph["published_time"] ?? named.get("date") ?? null,
    image: image ? resolve(image, baseUrl) : null,
    favicon: link_href((rel) => rel.split(/\s+/).includes("icon")),
    openGraph,
    twitter,
    jsonLd,
  };
}

function textOf_raw(el: ContentElement): string {
  return el.children.map((child) => (child.type === "text" ? child.text : "")).join("");
}

function resolve(href: string, base: string | undefined): string {
  if (!base) {
    return href;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
