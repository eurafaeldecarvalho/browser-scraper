import { Browser, type BrowserOptions } from "./core/browser";
import { HttpClient, type HttpClientOptions } from "./core/http";
import type { Tab, WaitUntil } from "./core/tab";
import { htmlToMarkdown, type MarkdownOptions } from "./content/markdown";
import { extractMetadata, type PageMetadata } from "./content/metadata";

// One call, cheapest tier first:
//   http    — browserless request (curl-impersonate for a real Chrome TLS
//             fingerprint when configured). Milliseconds, no Chrome.
//   browser — the stealth Chrome (no Runtime.enable, coherent persona). Runs
//             the page's JavaScript; needed for SPAs and soft bot checks.
//   stealth — same browser plus a behavioral warm-up and an interactive
//             Cloudflare Turnstile solve when a challenge is on the page.
// strategy "auto" escalates only when a tier looks blocked or empty, and the
// result reports which tier produced it, so you can see what each URL costs.

export type ScrapeFormat = "markdown" | "html" | "metadata" | "links" | "screenshot";
export type ScrapeTier = "http" | "browser" | "stealth";

export type ScrapeOptions = {
  url: string;
  // Default ["markdown", "metadata"].
  formats?: ScrapeFormat[];
  // "auto" (default) = http → browser → stealth. Pick one tier to pin it.
  strategy?: "auto" | ScrapeTier;
  // Reuse a running Browser (recommended for many URLs). When omitted, one is
  // launched with `browserOptions` and closed before returning.
  browser?: Browser;
  browserOptions?: BrowserOptions;
  // Options for the HTTP tier (e.g. { curlImpersonate: "curl_chrome131" }). With
  // a reused `browser`, its persona + proxy are applied automatically.
  http?: Partial<HttpClientOptions>;
  markdown?: MarkdownOptions & { includeIframes?: boolean };
  waitUntil?: WaitUntil;
  timeoutMs?: number;
};

export type ScrapeAttempt = { tier: ScrapeTier; ok: boolean; reason?: string; ms: number };

export type ScrapeResult = {
  url: string;
  tier: ScrapeTier;
  // HTTP status of the http tier; null when the page came from the browser.
  status: number | null;
  title: string;
  markdown?: string;
  html?: string;
  metadata?: PageMetadata;
  links?: Array<{ text: string; href: string }>;
  screenshot?: Buffer;
  attempts: ScrapeAttempt[];
};

export class ScrapeError extends Error {
  attempts: ScrapeAttempt[];

  constructor(message: string, attempts: ScrapeAttempt[]) {
    super(message);
    this.name = "ScrapeError";
    this.attempts = attempts;
  }
}

const BLOCK_STATUS = new Set([401, 403, 407, 429, 503]);
// The Turnstile widget marker: a widget embedded in a real page stays in its
// markup after it is solved, so it only counts while the challenge is unsolved.
// The challenge-platform markers below it mark the interstitial itself (in any
// language) and always count.
const TURNSTILE_MARKER = /challenges\.cloudflare\.com|cf-turnstile/i;
const CHALLENGE_MARKERS = [
  /<title>\s*(just a moment|attention required|access denied|verifying you are human|please wait|security check)/i,
  TURNSTILE_MARKER,
  /_cf_chl_opt|cf-browser-verification|cf_chl_/i,
  /captcha-delivery\.com|geo\.captcha-delivery|datadome/i,
  /perimeterx|px-captcha|_pxhd/i,
  /\/_Incapsula_Resource|incap_ses_/i,
  /g-recaptcha|h-captcha|hcaptcha\.com\/1\/api/i,
];

// Reasons that still return the page: it is short, or it may still be gated.
const isSoftReason = (reason: string) => reason.startsWith("almost no content") || reason.startsWith("solved challenge");

// Why a fetched page should not be trusted as the real content, or null.
export function detectBlock({ status, html, markdown, challengeSolved = false }: { status?: number | null; html: string; markdown?: string; challengeSolved?: boolean }): string | null {
  if (status != null && BLOCK_STATUS.has(status)) {
    return `HTTP ${status}`;
  }
  // Only look at the head + the start of the body: markers deep in a real
  // article (e.g. a blog post about Cloudflare) must not count.
  const text = markdown ?? htmlToMarkdown(html, { mainContent: false, links: "none", images: false }).markdown;
  const head = html.slice(0, 20_000);
  let solvedWidget = false;
  for (const marker of CHALLENGE_MARKERS) {
    if (marker.test(head) && text.length < 2_000) {
      if (challengeSolved && marker === TURNSTILE_MARKER) {
        solvedWidget = true;
        continue;
      }
      return `challenge page (${marker.source.split("|")[0].replace(/\\/g, "").slice(0, 40)})`;
    }
  }
  if (text.trim().length < 200 && (/<noscript[^>]*>[^<]*(enable|need|requires?)[^<]*javascript/i.test(html) || /<div id="(root|app|__next)">\s*<\/div>/i.test(html))) {
    return "needs JavaScript (empty app shell)";
  }
  // A short page that keeps a solved widget may be the real page (nowsecure.nl)
  // or a site's own Turnstile gate still waiting for a submit; the markup can't
  // tell them apart, so the page is returned but flagged.
  if (solvedWidget) {
    return "solved challenge still on the page (may be a gate)";
  }
  if (text.trim().length < 200) {
    return "almost no content";
  }
  return null;
}

export async function scrape(options: ScrapeOptions): Promise<ScrapeResult> {
  const formats = new Set<ScrapeFormat>(options.formats ?? ["markdown", "metadata"]);
  const strategy = options.strategy ?? "auto";
  const attempts: ScrapeAttempt[] = [];
  const timeout = options.timeoutMs ?? 30_000;

  let tiers: ScrapeTier[] = strategy === "auto" ? ["http", "browser", "stealth"] : [strategy];
  if (formats.has("screenshot")) {
    // A screenshot needs a rendered page.
    tiers = tiers.filter((tier) => tier !== "http");
  }

  // ---- http tier ----
  if (tiers.includes("http")) {
    const started = Date.now();
    try {
      const client = options.browser
        ? options.browser.createHttpClient({ timeoutMs: timeout, ...options.http })
        : new HttpClient({ proxy: options.browserOptions?.proxy ?? null, timeoutMs: timeout, ...options.http });
      const response = await client.get(options.url);
      const md = htmlToMarkdown(response.body, { baseUrl: response.url, ...options.markdown });
      const reason = detectBlock({ status: response.status, html: response.body, markdown: md.markdown });
      attempts.push({ tier: "http", ok: !reason, reason: reason ?? undefined, ms: Date.now() - started });

      if (!reason || tiers.length === 1) {
        if (reason && !isSoftReason(reason)) {
          throw new ScrapeError(`scrape(${options.url}) http tier: ${reason}`, attempts);
        }
        return {
          url: response.url,
          tier: "http",
          status: response.status,
          title: md.title,
          ...(formats.has("markdown") ? { markdown: md.markdown } : {}),
          ...(formats.has("html") ? { html: response.body } : {}),
          ...(formats.has("metadata") ? { metadata: extractMetadata(response.body, response.url) } : {}),
          ...(formats.has("links") ? { links: md.links } : {}),
          attempts,
        };
      }
    } catch (error) {
      if (error instanceof ScrapeError) {
        throw error;
      }
      attempts.push({ tier: "http", ok: false, reason: String((error as Error)?.message ?? error), ms: Date.now() - started });
      if (tiers.length === 1) {
        throw new ScrapeError(`scrape(${options.url}) http tier failed: ${String((error as Error)?.message ?? error)}`, attempts);
      }
    }
  }

  // ---- browser / stealth tiers (one tab, escalated in place) ----
  const owns_browser = !options.browser;
  const browser = options.browser ?? new Browser({ headless: true, ...options.browserOptions });
  let tab: Tab | null = null;

  try {
    tab = await browser.newTab();
    let loaded = false;
    let challengeSolved = false;

    for (const tier of tiers.filter((t) => t !== "http")) {
      const started = Date.now();
      try {
        if (!loaded) {
          await tab.goto({ url: options.url, waitUntil: options.waitUntil ?? "load", timeout });
          loaded = true;
          // Give client-side rendering a moment to settle.
          await tab.waitForFunction({ expression: "document.readyState === 'complete'", timeout: 5_000 }).catch(() => undefined);
          await tab.sleep({ milliseconds: 500 });
        }

        if (tier === "stealth") {
          await tab.ambientActivity({ durationMs: 1_200 });
          if (await tab.turnstilePresent()) {
            const solve = await tab.solveTurnstile({ timeoutMs: Math.min(timeout, 30_000) });
            challengeSolved = Boolean(solve?.solved);
          }
          // A solved challenge usually redirects to the real page.
          await tab.waitForNavigation({ timeout: 8_000 }).catch(() => undefined);
          await tab.sleep({ milliseconds: 800 });
        }

        const html = await tab.content();
        const md = await tab.markdown({ ...options.markdown });
        const reason = detectBlock({ html, markdown: md.markdown, challengeSolved });
        attempts.push({ tier, ok: !reason, reason: reason ?? undefined, ms: Date.now() - started });

        // Escalate to stealth only for a real block: a short page that rendered
        // fine in the browser is just a short page.
        const blocked = Boolean(reason) && !isSoftReason(reason!);
        const is_last = tier === tiers[tiers.length - 1];
        if (blocked && !is_last) {
          continue;
        }
        // A challenge / error page is never returned as content; a page that is
        // merely short is (some pages are tiny).
        if (reason && !isSoftReason(reason)) {
          throw new ScrapeError(`scrape(${options.url}) blocked on every tier: ${attempts.map((a) => `${a.tier}: ${a.reason}`).join("; ")}`, attempts);
        }

        return {
          url: md.url,
          tier,
          status: null,
          title: md.title,
          ...(formats.has("markdown") ? { markdown: md.markdown } : {}),
          ...(formats.has("html") ? { html } : {}),
          ...(formats.has("metadata") ? { metadata: await tab.metadata() } : {}),
          ...(formats.has("links") ? { links: md.links } : {}),
          ...(formats.has("screenshot") ? { screenshot: await tab.screenshot({ fullPage: true }) } : {}),
          attempts,
        };
      } catch (error) {
        if (error instanceof ScrapeError) {
          throw error;
        }
        attempts.push({ tier, ok: false, reason: String((error as Error)?.message ?? error), ms: Date.now() - started });
      }
    }

    throw new ScrapeError(`scrape(${options.url}) failed on every tier: ${attempts.map((a) => `${a.tier}: ${a.reason}`).join("; ")}`, attempts);
  } finally {
    if (tab) {
      await browser.closeTab(tab).catch(() => undefined);
    }
    if (owns_browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
