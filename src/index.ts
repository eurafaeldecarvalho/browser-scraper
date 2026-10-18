export {
  Browser,
  BrowserError,
  STEALTH_FLAGS,
  LAMBDA_FLAGS,
  SHELL_WEBGL_FLAGS,
  DEFAULT_WEBGL_VENDOR,
  DEFAULT_WEBGL_RENDERER,
  resolveSparticuz,
  type BrowserOptions,
  type ResolvedChromium,
} from "./core/browser";
export { Tab, Dialog, type WaitUntil, type TabStealth } from "./core/tab";
export { Element } from "./core/element";
export { CDPClient, CDPError } from "./core/cdp-client";
export { Network, Request, Response } from "./core/network";
export {
  HttpClient,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
} from "./core/http";
export { HumanMouse, getSharedMouse } from "./behavior/mouse";
export { Keyboard, deriveKey } from "./behavior/keyboard";
export { ProfileManager, ProfileStore, DEFAULT_HISTORY_SITES } from "./stealth/profile";
export { warmProfile } from "./stealth/warmup";
export {
  buildUserAgentMetadata,
  defaultWebglForPlatform,
  geoForCountry,
  platformFromUA,
  type GeoProfile,
  type PersonaPlatform,
  type WebGLIdentity,
} from "./stealth/persona";
export { buildEvasionSource, type EvasionOptions } from "./stealth/evasions";
export { ShadowRootAccessor } from "./shadow/shadow-root";
export { findChrome, getChromeVersion } from "./utils/chrome-finder";

export {
  scrape,
  detectBlock,
  ScrapeError,
  type ScrapeOptions,
  type ScrapeResult,
  type ScrapeFormat,
  type ScrapeTier,
  type ScrapeAttempt,
} from "./scrape";
export { htmlToMarkdown, treeToMarkdown, type MarkdownOptions, type MarkdownResult } from "./content/markdown";
export { extractMetadata, type PageMetadata } from "./content/metadata";
export { renderSnapshot, type SnapshotOptions } from "./content/snapshot";
export { McpServer, parseEnvFile, type McpServerOptions } from "./mcp/server";

export const __version__ = "0.8.0";