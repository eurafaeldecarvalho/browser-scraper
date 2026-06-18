import { spawn, type ChildProcess } from "node:child_process";

import { platformFromUA } from "../stealth/persona";

// Browserless HTTP fast lane. For cheap / unprotected endpoints (JSON APIs, static
// HTML) a full tab is wasteful: this issues a single request with persona-coherent
// headers and the configured proxy WITHOUT launching Chrome.
//
// The catch is the TLS layer. The dominant pre-JS bot signals are IP/ASN and the
// TLS (JA3/JA4) + HTTP/2 fingerprint, and a plain Node request emits NODE's TLS
// fingerprint — which a hard anti-bot (Cloudflare/Akamai) flags instantly. So:
//   * set `curlImpersonate` to a curl-impersonate binary (e.g. "curl_chrome131" or
//     the full path to "curl-impersonate-chrome") and the request is shelled
//     through it, giving a GENUINE Chrome JA3/JA4 + HTTP/2 fingerprint + proxy —
//     this is the only honest way to get real-Chrome TLS without a browser;
//   * otherwise the Node `fetch` fallback is used. It sends coherent headers but
//     Node's TLS fingerprint, which is fine for unprotected targets and a tell for
//     protected ones. A proxy with no curl-impersonate THROWS rather than silently
//     leaking the box's IP / wrong TLS.
//
// Not a stealth replacement for the browser — it is a complement for the requests
// that don't need a DOM. For anything behind a real anti-bot, drive a tab.

export type HttpClientOptions = {
  userAgent?: string | null;
  // Plain comma list (e.g. "pt-BR,pt,en") OR a ready q-weighted header value; a
  // q-less list is expanded to the q-weighted form Chrome actually sends.
  acceptLanguage?: string | null;
  // http(s)://host:port (no embedded credentials — pass those via proxyAuth).
  proxy?: string | null;
  proxyAuth?: [string, string] | null;
  // curl-impersonate binary name or path. When set, requests go through it for a
  // real-Chrome TLS/JA3/JA4 + HTTP/2 fingerprint. Wrapper scripts (curl_chromeNNN)
  // already pin an --impersonate target, so leave impersonateTarget unset for them;
  // for the raw "curl-impersonate-chrome" binary, set impersonateTarget.
  curlImpersonate?: string | null;
  impersonateTarget?: string | null;
  timeoutMs?: number;
  // Hard cap on the response body buffered from the curl-impersonate path, so a
  // huge/streaming/decompression-bomb response can't OOM the process. Default 32MB.
  maxResponseBytes?: number;
};

export type HttpRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  // Convenience: name->value cookies serialized into one Cookie header (merged
  // with any Cookie already in `headers`). Pull them from a tab via getCookies().
  cookies?: Record<string, string> | null;
};

export type HttpResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  // Real TLS path (curl-impersonate) vs Node-fetch fallback, so a caller can tell
  // whether the request carried a genuine Chrome wire fingerprint.
  impersonated: boolean;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class HttpClient {
  private _options: HttpClientOptions;

  constructor(options: HttpClientOptions = {}) {
    this._options = options;
  }

  async get(url: string, extra: Omit<HttpRequest, "url" | "method"> = {}): Promise<HttpResponse> {
    return this.request({ url, method: "GET", ...extra });
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const ua = this._options.userAgent || DEFAULT_UA;
    const method = (req.method ?? "GET").toUpperCase();

    // A GET/HEAD body is illegal in fetch (throws) and silently turns a curl
    // request into a POST — reject it up front so both transports behave the same.
    if ((method === "GET" || method === "HEAD") && req.body != null) {
      throw new Error(`HttpClient: a ${method} request cannot have a body.`);
    }

    const headers = this._build_headers(ua, req);

    if (this._options.curlImpersonate) {
      return this._request_curl(req, method, headers);
    }

    if (this._options.proxy) {
      throw new Error(
        "HttpClient: a proxy is configured but no curl-impersonate binary is set. The Node fetch fallback cannot tunnel a proxy without leaking the host TLS fingerprint, which defeats the purpose. Install curl-impersonate and pass `curlImpersonate` (e.g. 'curl_chrome131'), or drop the proxy for direct fetches.",
      );
    }

    return this._request_fetch(req, method, headers);
  }

  // Builds Chrome-coherent request headers from the resolved UA. For the
  // curl-impersonate path the binary owns the canonical header SET + ORDER (its
  // whole value), so we only add what is request-specific (Cookie, an explicit
  // Accept-Language) and let it own the rest; for the fetch fallback we emit the
  // full navigation header set.
  private _build_headers(ua: string, req: HttpRequest): Record<string, string> {
    const cookie_header = this._cookie_header(req);
    const accept_language = this._options.acceptLanguage ? qualify_accept_language(this._options.acceptLanguage) : null;

    if (this._options.curlImpersonate) {
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (cookie_header && !has_header(headers, "cookie")) {
        headers.Cookie = cookie_header;
      }
      if (accept_language && !has_header(headers, "accept-language")) {
        headers["Accept-Language"] = accept_language;
      }
      return headers;
    }

    const major = ua.match(/Chrome\/(\d+)/)?.[1] ?? "131";
    const platform = platformFromUA(ua);
    const ch_platform =
      platform === "macOS" ? '"macOS"' : platform === "Windows" ? '"Windows"' : platform === "Android" ? '"Android"' : '"Linux"';

    const base: Record<string, string> = {
      "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`,
      "sec-ch-ua-mobile": platform === "Android" ? "?1" : "?0",
      "sec-ch-ua-platform": ch_platform,
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": ua,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      // No Accept-Encoding: undici (Node fetch) manages its own and transparently
      // decodes the response, so declaring an encoding it may not honor as stated
      // would be an incoherent header on this (already non-Chrome-TLS) fallback path.
      "Accept-Language": accept_language ?? "en-US,en;q=0.9",
    };

    const merged = { ...base, ...(req.headers ?? {}) };
    if (cookie_header && !has_header(merged, "cookie")) {
      merged.Cookie = cookie_header;
    }
    return merged;
  }

  private _cookie_header(req: HttpRequest): string | null {
    if (!req.cookies || Object.keys(req.cookies).length === 0) {
      return null;
    }
    return Object.entries(req.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private async _request_curl(req: HttpRequest, method: string, headers: Record<string, string>): Promise<HttpResponse> {
    const bin = this._options.curlImpersonate as string;
    const timeout_s = Math.ceil((this._options.timeoutMs ?? 30_000) / 1000);

    const args = ["-sS", "-i", "-L", "--compressed", "--max-time", String(timeout_s)];

    if (this._options.impersonateTarget) {
      args.push("--impersonate", this._options.impersonateTarget);
    }

    if (this._options.proxy) {
      args.push("-x", this._proxy_url());
    }

    for (const [name, value] of Object.entries(headers)) {
      args.push("-H", `${name}: ${value}`);
    }

    if (method !== "GET") {
      args.push("-X", method);
    }

    if (req.body != null) {
      args.push("--data-raw", req.body);
    }

    args.push(req.url);

    const raw = await spawn_collect(
      bin,
      args,
      this._options.timeoutMs ?? 30_000,
      this._options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    const parsed = parse_raw_http(raw.toString("utf-8"));
    return { url: req.url, status: parsed.status, headers: parsed.headers, body: parsed.body, impersonated: true };
  }

  private async _request_fetch(req: HttpRequest, method: string, headers: Record<string, string>): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._options.timeoutMs ?? 30_000);
    try {
      const res = await fetch(req.url, {
        method,
        headers,
        body: req.body ?? undefined,
        redirect: "follow",
        signal: controller.signal,
      });
      const body = await res.text();
      const out_headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        out_headers[key] = value;
      });
      return { url: res.url || req.url, status: res.status, headers: out_headers, body, impersonated: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private _proxy_url(): string {
    const proxy = this._options.proxy as string;
    const auth = this._options.proxyAuth;
    if (!auth) {
      return proxy;
    }
    try {
      const url = new URL(proxy);
      url.username = encodeURIComponent(auth[0]);
      url.password = encodeURIComponent(auth[1]);
      return url.toString();
    } catch {
      return proxy;
    }
  }
}

// Expands a plain comma list ("pt-BR,pt,en") into the q-weighted form a real Chrome
// sends ("pt-BR,pt;q=0.9,en;q=0.8"). A value that already carries ";q=" is returned
// untouched.
function qualify_accept_language(list: string): string {
  if (list.includes(";q=")) {
    return list;
  }
  const parts = list.split(",").map((token) => token.trim()).filter(Boolean);
  if (parts.length === 0) {
    return list;
  }
  return parts
    .map((lang, index) => {
      if (index === 0) {
        return lang;
      }
      const q = Math.max(0.1, 1 - index * 0.1);
      return `${lang};q=${q.toFixed(1)}`;
    })
    .join(",");
}

function has_header(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

// Spawns the curl-impersonate binary, collects stdout (capped at max_bytes so a
// huge/streaming body can't OOM), rejects with a clear error on a missing binary
// (ENOENT), a non-zero exit, the size cap, or the timeout. Settles exactly once.
function spawn_collect(bin: string, args: string[], timeout_ms: number, max_bytes: number): Promise<Buffer> {
  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return Promise.reject(error);
  }

  const proc = child;
  return new Promise<Buffer>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let out_len = 0;
    let err_len = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(() => reject(new Error(`HttpClient: curl-impersonate timed out after ${timeout_ms}ms`)));
    }, timeout_ms + 1_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      out_len += chunk.length;
      if (out_len > max_bytes) {
        proc.kill("SIGKILL");
        finish(() => reject(new Error(`HttpClient: response exceeded maxResponseBytes (${max_bytes})`)));
        return;
      }
      out.push(chunk);
    });
    // Keep only a small head of stderr — enough for the error message, never unbounded.
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (err_len < 8_192) {
        err.push(chunk);
        err_len += chunk.length;
      }
    });

    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(() =>
          reject(
            new Error(
              `HttpClient: curl-impersonate binary "${bin}" not found. Install curl-impersonate (https://github.com/lwthiker/curl-impersonate) and pass its name/path as curlImpersonate.`,
            ),
          ),
        );
        return;
      }
      finish(() => reject(error));
    });

    proc.on("close", (code: number | null) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(out));
          return;
        }
        reject(new Error(`HttpClient: curl-impersonate exited ${code}: ${Buffer.concat(err).toString("utf-8").trim()}`));
      });
    });
  });
}

// Parses curl's `-i` output into the FINAL response's status/headers/body. curl
// emits one header block per hop (proxy CONNECT 200, 1xx, and each -L redirect),
// then the final body. We consume header blocks STRICTLY from the top — a block is
// only treated as headers if it both starts with "HTTP/" AND is followed by another
// "HTTP/" block; the first block whose successor is NOT a status line is the final
// response, and everything after its blank line is the body. This means a body that
// merely CONTAINS an HTTP-status-looking line can never hijack the parse.
function parse_raw_http(raw: string): { status: number; headers: Record<string, string>; body: string } {
  let rest = raw;
  let header_text = "";
  let body = "";

  while (/^HTTP\/\d/.test(rest)) {
    const sep = rest.search(/\r\n\r\n|\n\n/);
    if (sep < 0) {
      header_text = rest;
      rest = "";
      break;
    }
    header_text = rest.slice(0, sep);
    const after = rest.slice(sep).replace(/^(\r\n\r\n|\n\n)/, "");
    if (/^HTTP\/\d/.test(after)) {
      // Another header block follows (CONNECT / 1xx / redirect hop) — keep going.
      rest = after;
      continue;
    }
    // `after` is the final response body.
    body = after;
    break;
  }

  if (!header_text) {
    return { status: 0, headers: {}, body: raw };
  }

  const lines = header_text.split(/\r\n|\n/);
  const status = Number(lines[0]?.match(/\bHTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? 0);

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }

  return { status, headers, body };
}
