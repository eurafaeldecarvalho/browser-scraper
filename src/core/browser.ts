import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defaultWebglForPlatform, geoForCountry, platformFromUA, type GeoProfile } from "../stealth/persona";
import { ProfileManager } from "../stealth/profile";
import { findChrome } from "../utils/chrome-finder";
import { Tab, type TabStealth } from "./tab";

// Flags chosen to reduce automation signals WITHOUT introducing new ones.
// Intentionally omitted because their mere presence is a fingerprint that
// only automation sets (see patchright): --disable-extensions,
// --disable-popup-blocking, --disable-component-update, --enable-automation.
export const STEALTH_FLAGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--disable-features=AutofillServerCommunication,Translate",
];

// Extra flags required to run Chrome inside a constrained Linux container such
// as AWS Lambda. Kept SEPARATE from STEALTH_FLAGS because --no-sandbox is a mild
// automation correlate on a normal desktop; only add these where the OS sandbox
// genuinely cannot run. Enabled via `lambda: true` (or pass through extraArgs).
export const LAMBDA_FLAGS = ["--no-sandbox", "--disable-dev-shm-usage"];

// Software-WebGL flags for a GPU-less host running chrome-headless-shell. Chrome
// 137+ removed the automatic SwiftShader fallback, so without these
// getContext('webgl') returns null on a GPU-less host — itself a headless tell,
// and it makes any WebGL identity inert (no context to read the value from).
// @sparticuz/chromium already sets equivalent flags in its default graphicsMode;
// these are added only when MISSING so the lib owns one coherent WebGL policy.
export const SHELL_WEBGL_FLAGS = ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"];

// How much of Chrome's stderr tail to retain for a launch-failure diagnostic
// (UTF-16 code units, not bytes — an approximation sufficient for a diagnostic).
const STDERR_RING_CHARS = 16_384;

// WebRTC IP-handling policy applied at launch. Fully disabling WebRTC is an
// anomaly fingerprinters flag (real Chrome has it working), so instead we keep
// it present and prevent IP leaks: behind a proxy, force all UDP through the
// proxy; otherwise expose only the public interface and hide local IPs.
function webrtc_flag(has_proxy: boolean): string {
  return has_proxy
    ? "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
    : "--force-webrtc-ip-handling-policy=default_public_interface_only";
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserError";
  }
}

export type ResolvedChromium = {
  executablePath: string;
  args: string[];
  // chrome-headless-shell is already headless ('shell' mode); the Browser must
  // NOT add --headless=new on top of it.
  shellMode: boolean;
};

// Resolves @sparticuz/chromium (an OPTIONAL dependency) for AWS Lambda ZIP
// deployments: returns its Lambda-tuned executablePath + args. The package ships
// chrome-headless-shell (already headless='shell'), so shellMode is true and the
// Browser must not re-apply a headless flag. Imported dynamically (variable
// specifier) so the ~150MB binary is never required off-Lambda and the package
// can stay an optional dep kept EXTERNAL by the bundler (it resolves its binary
// by relative path). Throws a clear error if the optional dep is absent.
//
//   const browser = new Browser({ chromium: await resolveSparticuz(), proxy });
export async function resolveSparticuz(): Promise<ResolvedChromium> {
  const pkg = "@sparticuz/chromium";
  let mod: any;
  try {
    mod = await import(pkg);
  } catch {
    throw new BrowserError(
      "resolveSparticuz() needs the optional dependency '@sparticuz/chromium'. Install it (pin the version to your Chromium target) and keep it EXTERNAL in your bundler — it resolves its bundled binary by relative path.",
    );
  }
  const chromium = mod?.default ?? mod;
  const executablePath: string = await chromium.executablePath();
  const args: string[] = Array.isArray(chromium.args) ? chromium.args : [];
  return { executablePath, args, shellMode: true };
}

type StealthScreen = { width: number; height: number };

type BrowserOptions = {
  chromePath?: string | null;
  headless?: boolean;
  userDataDir?: string | null;
  proxy?: string | null;
  extraArgs?: string[] | null;
  autoSeed?: boolean;
  // Override the User-Agent for the WHOLE persona. Resolved before the tab
  // stealth config is built, so the spoofWebGL OS default, Client-Hints, and
  // platform all derive from THIS string (not the host UA), and it is also
  // passed as --user-agent at launch so it applies from the very first request.
  // Must be a real Chrome UA; keep the Chrome major consistent with the host
  // build (a different major desyncs the Client-Hints fullVersionList).
  userAgent?: string | null;
  // WebGL identity. Set both to report a specific GPU, or spoofWebGL:true to use
  // an OS-COHERENT default derived from the resolved UA platform (never a
  // Windows D3D11 string on a Linux UA). On a GPU-less host a discrete-GPU
  // string is only safe for soft targets — see README "GPU / WebGL".
  webglVendor?: string | null;
  webglRenderer?: string | null;
  spoofWebGL?: boolean;
  // Geo coherence. geoCountry (ISO-2, e.g. "BR") derives timezone + locale +
  // Accept-Language together; explicit fields override it. Applied automatically
  // when a tab connects so IP-geo, Intl timezone and navigator.languages agree.
  geoCountry?: string | null;
  timezone?: string | null;
  locale?: string | null;
  acceptLanguage?: string | null;
  // When true and no geoCountry/timezone/locale is set, the FIRST newTab() does a
  // one-time IP-geo lookup THROUGH the proxy to learn the exit country and sets
  // geoCountry automatically (so the persona matches the proxy region without you
  // hardcoding it). Costs one extra request at startup; explicit geo always wins.
  autoGeo?: boolean;
  // Hardware hint applied engine-level (propagates to workers). deviceMemory is
  // intentionally NOT spoofable — a main-world-only override would desync from
  // workers; see stealth/evasions.ts.
  hardwareConcurrency?: number | null;
  // Screen/window geometry reported to the page (fixes headless outerWidth===0).
  screen?: StealthScreen | null;
  windowSize?: StealthScreen | null;
  // Toggle the JS evasion init-scripts (webdriver / notifications / screen).
  // Default true.
  evasions?: boolean;
  // Adds --no-sandbox / --disable-dev-shm-usage for constrained containers.
  lambda?: boolean;
  // Warn once when launching with no proxy — direct datacenter egress is the
  // dominant detection vector regardless of fingerprint. Default true.
  warnOnDirectEgress?: boolean;
  // Browser channel. 'headless-shell' marks the binary as chrome-headless-shell
  // (e.g. @sparticuz/chromium on Lambda): it is ALREADY headless ('shell' mode),
  // so the lib never adds --headless=new on top of it, owns the software-WebGL
  // flags (SHELL_WEBGL_FLAGS), ensures HOME/XDG/user-data dirs exist, points the
  // session bus at /dev/null, and auto-applies the shell-specific JS shims
  // (window.chrome, navigator.connection) that a real headful Chrome has natively.
  channel?: "chrome" | "headless-shell" | null;
  // Pre-resolved chromium (e.g. `await resolveSparticuz()`): its executablePath
  // becomes chromePath and its args are merged at launch; shellMode implies
  // channel:'headless-shell'. Lets a Lambda consumer wire @sparticuz/chromium in
  // one line without hand-managing the binary path, args, and headless flag.
  chromium?: ResolvedChromium | null;
  // Receives Chrome's stderr in raw chunks (the launch/crash cause; a chunk may
  // span or split lines). Without this the process still captures a stderr ring
  // buffer that is attached to the BrowserError on a launch timeout, so a Lambda
  // OOM/seccomp death is no longer a bare "Timeout waiting for Chrome to start".
  onStderr?: ((chunk: string) => void) | null;
  // OPT-IN, OFF by default. CDP Input events historically report
  // screenX==clientX / screenY==clientY (Chromium bug 40280325) instead of true
  // global screen coords — an automation tell some checks (e.g. Turnstile) read
  // even though isTrusted is true. Setting an explicit {x,y} offset installs
  // MouseEvent.screenX/screenY getters returning clientX+x / clientY+y.
  // IMPORTANT: a ~Sept-2025 Chromium fix may already make your build report
  // correct coords — VERIFY empirically on your exact binary first; applying an
  // offset over an already-correct value just creates a NEW, different tell.
  screenCoordOffset?: { x: number; y: number } | null;
};

// Backwards-compatible Windows GPU identity (still exported). The default is now
// resolved per-OS from the UA at tab-creation time via persona; this constant is
// the Windows branch and is only applied under a Windows UA.
export const DEFAULT_WEBGL_VENDOR = "Google Inc. (NVIDIA)";
export const DEFAULT_WEBGL_RENDERER =
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";

export class Browser {
  chromePath: string;
  headless: boolean;
  userDataDir: string | null;
  extraArgs: string[];
  autoSeed: boolean;
  proxy: string | null;
  proxyAuth: [string, string] | null = null;
  userAgent: string | null;
  webglVendor: string | null;
  webglRenderer: string | null;
  spoofWebGL: boolean;
  geoCountry: string | null;
  timezone: string | null;
  locale: string | null;
  acceptLanguage: string | null;
  autoGeo: boolean;
  hardwareConcurrency: number | null;
  screen: StealthScreen | null;
  windowSize: StealthScreen | null;
  evasions: boolean;
  lambda: boolean;
  warnOnDirectEgress: boolean;
  channel: "chrome" | "headless-shell";
  onStderr: ((chunk: string) => void) | null;
  screenCoordOffset: { x: number; y: number } | null;

  private _process: ChildProcess | null = null;
  private _temp_dir: string | null = null;
  private _debug_port = 0;
  private _ws_endpoint: string | null = null;
  private _user_agent: string | null = null;
  private _browser_version: string | null = null;
  private _auto_geo_resolved = false;
  private _tabs: Tab[] = [];
  // True when running chrome-headless-shell (channel / resolved chromium): the
  // binary is already headless and the lib applies the shell-specific policy.
  private _shell_mode = false;
  // Extra launch args from a resolved chromium (e.g. @sparticuz/chromium.args).
  private _chromium_args: string[] = [];
  // Rolling tail of Chrome's stderr (last ~16KB) so a launch failure can report
  // the REAL cause instead of a generic timeout.
  private _stderr_ring = "";

  constructor(
    chrome_path_or_options: string | BrowserOptions | null = null,
    headless = false,
    user_data_dir: string | null = null,
    proxy: string | null = null,
    extra_args: string[] | null = null,
    auto_seed = true,
  ) {
    const options = normalize_browser_options(
      chrome_path_or_options,
      headless,
      user_data_dir,
      proxy,
      extra_args,
      auto_seed,
    );

    const resolvedChromium = options.chromium ?? null;
    this.chromePath = resolvedChromium?.executablePath ?? options.chromePath ?? findChrome() ?? "";
    if (!this.chromePath) {
      throw new BrowserError("Could not find Chrome. Please install Chrome or provide path.");
    }

    this.headless = options.headless ?? false;
    this.userDataDir = options.userDataDir ?? null;
    this.extraArgs = options.extraArgs ?? [];
    this.autoSeed = options.autoSeed ?? true;
    this.proxy = options.proxy ?? null;
    this.userAgent = options.userAgent ?? null;
    this.webglVendor = options.webglVendor ?? null;
    this.webglRenderer = options.webglRenderer ?? null;
    this.spoofWebGL = options.spoofWebGL ?? false;
    this.geoCountry = options.geoCountry ?? null;
    this.timezone = options.timezone ?? null;
    this.locale = options.locale ?? null;
    this.acceptLanguage = options.acceptLanguage ?? null;
    this.autoGeo = options.autoGeo ?? false;
    this.hardwareConcurrency = options.hardwareConcurrency ?? null;
    this.screen = options.screen ?? null;
    this.windowSize = options.windowSize ?? null;
    this.evasions = options.evasions ?? true;
    this.lambda = options.lambda ?? false;
    this.warnOnDirectEgress = options.warnOnDirectEgress ?? true;
    this.channel = options.channel ?? (resolvedChromium?.shellMode ? "headless-shell" : "chrome");
    this._shell_mode = this.channel === "headless-shell" || Boolean(resolvedChromium?.shellMode);
    this._chromium_args = resolvedChromium?.args ?? [];
    this.onStderr = options.onStderr ?? null;
    this.screenCoordOffset = options.screenCoordOffset ?? null;

    // An unmapped geoCountry with no explicit timezone/locale would silently
    // apply NO geo emulation — leaving UTC on a foreign IP, a hard tell. Surface
    // it loudly rather than failing closed.
    if (this.geoCountry && !geoForCountry(this.geoCountry) && !this.timezone && !this.locale) {
      console.warn(
        `[browser-scraper] geoCountry "${this.geoCountry}" is not in the built-in map and no explicit timezone/locale was given, so NO geo emulation will be applied (the page may run UTC against a foreign IP — a hard tell). Pass explicit timezone + locale, or use a mapped country code.`,
      );
    }

    if (this.proxy) {
      this._parse_proxy(this.proxy);
    }
  }

  private _parse_proxy(proxy: string): void {
    const parsed = new URL(proxy);
    if (parsed.username && parsed.password) {
      // Chrome's network stack cannot authenticate SOCKS proxies (no SOCKS
      // user/pass negotiation); only HTTP/HTTPS proxy auth works, via the Fetch
      // challenge path. Silently dropping the credentials would yield an
      // unauthenticated tunnel that fails as ERR_SOCKS_CONNECTION_FAILED, so fail
      // loudly with actionable guidance instead.
      if (/^socks/i.test(parsed.protocol)) {
        throw new BrowserError(
          "Authenticated SOCKS proxies are not supported by Chrome. Use an http(s):// proxy for username/password auth, or front the SOCKS proxy with a local auth-forwarding relay.",
        );
      }
      this.proxyAuth = [decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)];
      this.proxy = parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : `${parsed.protocol}//${parsed.hostname}`;
      return;
    }

    this.proxy = proxy;
  }

  // Resolves the geo profile to apply: explicit timezone/locale/acceptLanguage
  // win, otherwise derived from geoCountry. Returns null when nothing is set.
  private _resolve_geo(): Partial<GeoProfile> | null {
    const base: GeoProfile | null = this.geoCountry ? geoForCountry(this.geoCountry) : null;
    const timezone = this.timezone ?? base?.timezone;
    const locale = this.locale ?? base?.locale;
    // Plain comma list, NO q-values: Chrome derives navigator.languages verbatim
    // from this string and does not strip ";q=", so a q there becomes a literal
    // bogus language token.
    const acceptLanguage = this.acceptLanguage ?? base?.acceptLanguage ?? (locale ? `${locale},${locale.split("-")[0]}` : undefined);

    if (!timezone && !locale && !acceptLanguage) {
      return null;
    }

    return { timezone, locale, acceptLanguage } as Partial<GeoProfile>;
  }

  // Builds the per-tab stealth config from the resolved UA platform so WebGL,
  // geo, hardware and screen are all internally consistent.
  private _build_tab_stealth(): TabStealth {
    const platform = platformFromUA(this._user_agent ?? "");

    let webgl: { vendor: string; renderer: string } | null = null;
    let webglAuto = false;
    if (this.webglVendor && this.webglRenderer) {
      webgl = { vendor: this.webglVendor, renderer: this.webglRenderer };
    } else if (this.spoofWebGL) {
      webgl = defaultWebglForPlatform(platform);
      webglAuto = true; // OS-derived — must follow a later setUserAgent OS switch
    }

    return {
      userAgent: this._user_agent,
      fullVersion: this._browser_version,
      proxyAuth: this.proxyAuth,
      webgl,
      webglAuto,
      geo: this._resolve_geo(),
      hardwareConcurrency: this.hardwareConcurrency,
      // windowSize sizes the OS window; reuse it as the screen identity when no
      // explicit screen is given so the geometry coherence still applies.
      screen: this.screen ?? this.windowSize,
      evasions: this.evasions,
      // chrome-headless-shell lacks surfaces a real headful Chrome has
      // (window.chrome, a non-zero navigator.connection.rtt). Tell the tab to
      // apply the conditional shell shims when running that binary.
      shellMode: this._shell_mode,
      screenCoordOffset: this.screenCoordOffset,
    };
  }

  async launch(): Promise<void> {
    if (this._process) {
      return;
    }

    if (!this.userDataDir) {
      this._temp_dir = await mkdtemp(join(tmpdir(), "gdnium_"));
      this.userDataDir = this._temp_dir;
    }

    if (this.autoSeed && this._temp_dir) {
      this._seed_profile();
    }

    // chrome-headless-shell on Lambda needs HOME + the XDG dirs to exist and be
    // writable (they live under the ephemeral /tmp and vanish each cold start).
    if (this._shell_mode) {
      await this._ensure_browser_dirs();
    }

    if (this.warnOnDirectEgress && !this.proxy) {
      console.warn(
        "[browser-scraper] Launching with NO proxy. Direct datacenter egress (e.g. AWS Lambda/EC2) is the dominant antibot detection vector and will tank reCAPTCHA v3 scores / trigger Cloudflare regardless of fingerprint quality. Route protected targets through a residential/mobile proxy. (set warnOnDirectEgress:false to silence)",
      );
    }

    this._debug_port = await this._find_free_port();

    const win = this.windowSize ?? this.screen ?? { width: 1920, height: 1080 };

    const args = [
      ...STEALTH_FLAGS,
      webrtc_flag(Boolean(this.proxy)),
      `--window-size=${win.width},${win.height}`,
      `--remote-debugging-port=${this._debug_port}`,
      `--user-data-dir=${this.userDataDir}`,
    ];

    // Apply a UA override from launch so it carries on the very first request,
    // not just after the per-tab Network.setUserAgentOverride.
    if (this.userAgent) {
      args.push(`--user-agent=${this.userAgent}`);
    }

    if (this._shell_mode) {
      // chrome-headless-shell is ALREADY headless ('shell' mode): never add
      // --headless=new on top (that flag exists only in the full browser and
      // would conflict). Own the software-WebGL flags so a GPU-less host still
      // yields a (SwiftShader) context — added only when neither these args nor
      // the resolved chromium args already carry them, to avoid duplicates.
      for (const flag of SHELL_WEBGL_FLAGS) {
        const key = flag.split("=")[0];
        if (!args.some((a) => a.startsWith(key)) && !this._chromium_args.some((a) => a.startsWith(key))) {
          args.push(flag);
        }
      }
    } else if (this.headless) {
      args.push("--headless=new");
      // Chrome 137+ removed the automatic SwiftShader WebGL fallback: on a
      // GPU-less host getContext('webgl') returns null — itself a headless tell,
      // and it makes any WebGL spoof inert (no context to read the value from).
      // Re-enable the software fallback so a context always exists. With a real
      // GPU present (e.g. EC2 g4dn), the GPU pipeline is still used.
      args.push("--enable-unsafe-swiftshader");
    }

    // --no-sandbox / --disable-dev-shm-usage: required by lambda:true AND implied
    // by shell mode (a chrome-headless-shell binary is a constrained/sandboxless
    // deploy by definition). Deduped against the resolved chromium args so
    // @sparticuz/chromium (which already carries them) isn't given duplicates.
    if (this.lambda || this._shell_mode) {
      for (const flag of LAMBDA_FLAGS) {
        const key = flag.split("=")[0];
        if (!args.some((a) => a.startsWith(key)) && !this._chromium_args.some((a) => a.startsWith(key))) {
          args.push(flag);
        }
      }
    }

    if (this.proxy) {
      args.push(`--proxy-server=${this.proxy}`);
    }

    // Resolved-chromium args (e.g. @sparticuz/chromium's Lambda-tuned set) come
    // before the caller's extraArgs so an explicit extraArg always wins.
    args.push(...this._chromium_args, ...this.extraArgs, "about:blank");

    this._process = spawn(this.chromePath, args, {
      // Capture stderr (the real launch/crash cause) instead of /dev/null, so a
      // Lambda seccomp/OOM death surfaces in the BrowserError rather than a bare
      // "Timeout waiting for Chrome to start".
      stdio: ["ignore", "ignore", "pipe"],
      env: this._spawn_env(),
    });
    this._attach_stderr_capture();

    try {
      this._ws_endpoint = await this._get_ws_endpoint();
    } catch (error) {
      // Launch failed (e.g. Chrome died under a Lambda seccomp/OOM). Tear down the
      // half-spawned process + temp profile so a retry starts clean and neither
      // leaks. The thrown BrowserError already carries the captured stderr tail.
      await this._teardown_failed_launch();
      throw error;
    }
  }

  // Minimal teardown for a launch that never reached a live CDP endpoint: SIGKILL
  // the process and drop the temp profile (only the one WE created), so a caller
  // retry re-creates a clean profile and nothing is leaked.
  private async _teardown_failed_launch(): Promise<void> {
    if (this._process) {
      try {
        this._process.kill("SIGKILL");
      } catch {
        // already gone
      }
      this._process = null;
    }
    if (this._temp_dir) {
      await rm(this._temp_dir, { recursive: true, force: true }).catch(() => {});
      this._temp_dir = null;
      this.userDataDir = null;
    }
  }

  async close(): Promise<void> {
    for (const tab of this._tabs) {
      await tab.close();
    }
    this._tabs = [];

    if (this._process) {
      const process = this._process;
      const exited = new Promise<void>((resolve) => {
        process.once("exit", () => resolve());
      });

      process.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);

      if (process.exitCode === null) {
        process.kill("SIGKILL");
        await Promise.race([exited, delay(1_000)]);
      }

      this._process = null;
    }

    if (this._temp_dir) {
      await rm(this._temp_dir, { recursive: true, force: true });
      this._temp_dir = null;
    }
  }

  async newTab({ url = "about:blank" }: { url?: string } = {}): Promise<Tab> {
    if (!this._process) {
      await this.launch();
    }

    // One-time: learn the proxy exit country and set geoCountry before the first
    // real tab's stealth config is built, so its timezone/locale/Accept-Language
    // match the proxy region. Explicit geo (geoCountry/timezone/locale) skips it.
    if (this.autoGeo && !this._auto_geo_resolved && !this.geoCountry && !this.timezone && !this.locale) {
      await this._resolve_auto_geo();
    }

    const response = await fetch(`http://127.0.0.1:${this._debug_port}/json/new?${url}`, {
      method: "PUT",
    });
    const target_info = await response.json();

    const ws_url = target_info.webSocketDebuggerUrl;
    if (!ws_url) {
      throw new BrowserError("Failed to get WebSocket URL for new tab");
    }

    const tab = new Tab(ws_url, target_info, this._build_tab_stealth());
    await tab.connect();
    this._tabs.push(tab);
    return tab;
  }

  async getTabs(): Promise<Record<string, any>[]> {
    const response = await fetch(`http://127.0.0.1:${this._debug_port}/json`);
    return response.json();
  }

  // Opt-in egress reputation check: navigates a throwaway tab through the
  // configured proxy to an IP-info endpoint and reports the exit IP's ASN/org
  // and whether it is flagged as hosting/datacenter. Datacenter egress is the
  // dominant antibot signal, so this surfaces the #1 problem before a scrape run.
  // Returns null if the lookup fails.
  async checkEgress(): Promise<{ ip: string; org: string; country: string; hosting: boolean } | null> {
    type EgressResult = { ip: string; org: string; country: string; hosting: boolean };
    // ip-api carries an explicit 'hosting' flag but is HTTP-only on the free
    // tier; ipinfo (HTTPS) is the fallback when the proxy blocks :80 egress —
    // there the datacenter ASN is inferred from the org string.
    const attempts: Array<{ url: string; parse: (d: any) => EgressResult }> = [
      {
        url: "http://ip-api.com/json/?fields=query,org,as,countryCode,hosting",
        parse: (d) => ({ ip: String(d.query ?? ""), org: String(d.org || d.as || ""), country: String(d.countryCode ?? ""), hosting: Boolean(d.hosting) }),
      },
      {
        url: "https://ipinfo.io/json",
        parse: (d) => ({
          ip: String(d.ip ?? ""),
          org: String(d.org ?? ""),
          country: String(d.country ?? ""),
          hosting: /hosting|cloud|amazon|aws|google|microsoft|azure|datacenter|ovh|digitalocean|hetzner|linode|vultr/i.test(String(d.org ?? "")),
        }),
      },
    ];

    const tab = await this.newTab();
    let last_error: unknown = null;
    try {
      for (const attempt of attempts) {
        try {
          await tab.goto({ url: attempt.url, waitUntil: "domcontentloaded", timeout: 15_000 });
          const body = await tab.evaluate({ expression: "document.body.innerText" });
          const result = attempt.parse(JSON.parse(String(body ?? "{}")));
          if (!result.ip) {
            continue;
          }
          if (result.hosting && this.warnOnDirectEgress) {
            console.warn(
              `[browser-scraper] Egress IP ${result.ip} (${result.org}) looks like HOSTING/datacenter. Expect low reCAPTCHA v3 scores and Cloudflare/DataDome challenges regardless of fingerprint. Route through a residential/mobile proxy.`,
            );
          }
          return result;
        } catch (error) {
          last_error = error;
        }
      }
      // Do NOT swallow silently: a failed egress check must not read as "clean".
      console.warn(`[browser-scraper] checkEgress: could not determine the exit IP (all lookups failed). Last error: ${String(last_error)}`);
      return null;
    } finally {
      await tab.close();
    }
  }

  // Resolves geoCountry from the proxy exit country (one-time). Sets the resolved
  // flag FIRST so the throwaway lookup tab created by checkEgress() does not
  // re-enter this path. Leaves geoCountry unset (with a warning) when the country
  // can't be determined or isn't in the built-in map.
  private async _resolve_auto_geo(): Promise<void> {
    this._auto_geo_resolved = true;

    let result: { country: string } | null = null;
    try {
      result = await this.checkEgress();
    } catch {
      result = null;
    }

    const country = result?.country?.trim().toUpperCase() ?? "";
    if (country && geoForCountry(country)) {
      this.geoCountry = country;
      return;
    }

    if (this.warnOnDirectEgress) {
      if (country) {
        console.warn(
          `[browser-scraper] autoGeo: proxy exit country "${country}" is not in the built-in geo map — no geo emulation applied. Pass an explicit timezone + locale for it, or extend the map.`,
        );
      } else {
        console.warn(
          "[browser-scraper] autoGeo: could not determine the proxy exit country — no geo emulation applied.",
        );
      }
    }
  }

  private async _find_free_port(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return port;
  }

  private async _get_ws_endpoint(timeout = 30_000): Promise<string> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      try {
        const response = await fetch(`http://127.0.0.1:${this._debug_port}/json/version`);
        const data = await response.json();
        if (data.webSocketDebuggerUrl) {
          // A caller-supplied UA override wins so the whole persona (WebGL OS
          // default, Client-Hints, platform) derives from it; otherwise use the
          // launched browser's own UA with the headless marker stripped.
          if (this.userAgent) {
            this._user_agent = this.userAgent;
          } else if (typeof data["User-Agent"] === "string") {
            this._user_agent = strip_headless_ua(data["User-Agent"]);
          }
          if (typeof data.Browser === "string") {
            // e.g. "HeadlessChrome/120.0.6099.109" -> "120.0.6099.109"; gives the
            // real 4-part build for a coherent CH fullVersionList.
            this._browser_version = data.Browser.match(/[\d]+\.[\d.]+/)?.[0] ?? null;
          }
          return data.webSocketDebuggerUrl;
        }
      } catch {
      }

      await delay(200);
    }

    const tail = this._stderr_ring.trim();
    throw new BrowserError(
      `Timeout waiting for Chrome to start.${tail ? ` Chrome stderr (tail):\n${tail}` : " (no stderr captured)"}`,
    );
  }

  // Child env for the spawned Chrome. In shell mode, silences chrome-headless-
  // shell's libdbus autolaunch (there is no dbus-daemon on the Lambda runtime)
  // by pointing the session bus at /dev/null, unless the caller already set it.
  private _spawn_env(): NodeJS.ProcessEnv {
    if (!this._shell_mode) {
      return process.env;
    }
    return {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "/dev/null",
    };
  }

  // Buffers Chrome's stderr into a rolling tail (the real launch/crash cause) so
  // a startup failure reports WHY instead of a bare timeout, and forwards each
  // chunk to an optional onStderr hook. Replaces the old stdio:'ignore' that sent
  // the crash cause to /dev/null (a Lambda seccomp/OOM death was invisible).
  private _attach_stderr_capture(): void {
    const stderr = this._process?.stderr;
    if (!stderr) {
      return;
    }
    stderr.setEncoding("utf-8");
    stderr.on("data", (chunk: string) => {
      this._stderr_ring = (this._stderr_ring + chunk).slice(-STDERR_RING_CHARS);
      if (this.onStderr) {
        try {
          this.onStderr(chunk);
        } catch {
          // A logging hook must never break the launch.
        }
      }
    });
    stderr.on("error", () => {});
  }

  // Best-effort: create HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME when they are set
  // (on Lambda they point into /tmp and are recreated each cold start). Chrome
  // aborts early if HOME is unwritable.
  private async _ensure_browser_dirs(): Promise<void> {
    for (const dir of [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME]) {
      if (dir) {
        await mkdir(dir, { recursive: true }).catch(() => {});
      }
    }
  }

  private _seed_profile(): void {
    if (!this.userDataDir) {
      return;
    }

    try {
      const profile = new ProfileManager({ profileDir: this.userDataDir });
      profile.seedHistory();
      // Cookies are deliberately NOT seeded into the SQLite file: Chrome >=80
      // reads the OSCrypt-encrypted `encrypted_value` and IGNORES a plaintext
      // `value`, so a file write is inert (and a Cookies DB full of plaintext
      // values is itself a forensic anomaly if read). Inject a warmed cookie
      // bundle at RUNTIME via `tab.setCookies()` (CDP, encrypted with the live
      // profile key) instead — see ProfileManager.cookieSeeds() for the defaults.
    } catch {
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

// Removes the "Headless" marker that --headless=new injects into the
// User-Agent (and, by extension, the sec-ch-ua client hints), so a headless
// session is indistinguishable from a headful one at the UA level.
function strip_headless_ua(user_agent: string): string {
  return user_agent.replace(/HeadlessChrome/g, "Chrome");
}

function normalize_browser_options(
  chrome_path_or_options: string | BrowserOptions | null,
  headless: boolean,
  user_data_dir: string | null,
  proxy: string | null,
  extra_args: string[] | null,
  auto_seed: boolean,
): BrowserOptions {
  if (chrome_path_or_options && typeof chrome_path_or_options === "object" && !Array.isArray(chrome_path_or_options)) {
    return chrome_path_or_options;
  }

  return {
    chromePath: typeof chrome_path_or_options === "string" ? chrome_path_or_options : null,
    headless,
    userDataDir: user_data_dir,
    proxy,
    extraArgs: extra_args ?? [],
    autoSeed: auto_seed,
  };
}