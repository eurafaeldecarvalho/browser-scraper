import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ProfileManager } from "../stealth/profile";
import { findChrome } from "../utils/chrome-finder";
import { Tab } from "./tab";

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

type BrowserOptions = {
  chromePath?: string | null;
  headless?: boolean;
  userDataDir?: string | null;
  proxy?: string | null;
  extraArgs?: string[] | null;
  autoSeed?: boolean;
  // Set both to report a specific GPU. Or set spoofWebGL: true to use a
  // believable default — useful on GPU-less cloud hosts where Chrome would
  // otherwise leak SwiftShader/llvmpipe as the renderer.
  webglVendor?: string | null;
  webglRenderer?: string | null;
  spoofWebGL?: boolean;
};

// Default GPU identity to report when spoofing is requested without explicit
// strings. A common desktop NVIDIA via ANGLE/D3D11 — plausible for most hosts
// and far less suspicious than the SwiftShader/llvmpipe a GPU-less server emits.
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
  webglVendor: string | null;
  webglRenderer: string | null;

  private _process: ChildProcess | null = null;
  private _temp_dir: string | null = null;
  private _debug_port = 0;
  private _ws_endpoint: string | null = null;
  private _user_agent: string | null = null;
  private _tabs: Tab[] = [];

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

    this.chromePath = options.chromePath ?? findChrome() ?? "";
    if (!this.chromePath) {
      throw new BrowserError("Could not find Chrome. Please install Chrome or provide path.");
    }

    this.headless = options.headless ?? false;
    this.userDataDir = options.userDataDir ?? null;
    this.extraArgs = options.extraArgs ?? [];
    this.autoSeed = options.autoSeed ?? true;
    this.proxy = options.proxy ?? null;
    this.webglVendor = options.webglVendor ?? (options.spoofWebGL ? DEFAULT_WEBGL_VENDOR : null);
    this.webglRenderer = options.webglRenderer ?? (options.spoofWebGL ? DEFAULT_WEBGL_RENDERER : null);

    if (this.proxy) {
      this._parse_proxy(this.proxy);
    }
  }

  private _parse_proxy(proxy: string): void {
    const parsed = new URL(proxy);
    if (parsed.username && parsed.password) {
      this.proxyAuth = [decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)];
      this.proxy = parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : `${parsed.protocol}//${parsed.hostname}`;
      return;
    }

    this.proxy = proxy;
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

    this._debug_port = await this._find_free_port();

    const args = [
      ...STEALTH_FLAGS,
      webrtc_flag(Boolean(this.proxy)),
      `--remote-debugging-port=${this._debug_port}`,
      `--user-data-dir=${this.userDataDir}`,
    ];

    if (this.headless) {
      args.push("--headless=new");
    }

    if (this.proxy) {
      args.push(`--proxy-server=${this.proxy}`);
    }

    args.push(...this.extraArgs, "about:blank");

    this._process = spawn(this.chromePath, args, {
      stdio: "ignore",
    });

    this._ws_endpoint = await this._get_ws_endpoint();
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

    const response = await fetch(`http://127.0.0.1:${this._debug_port}/json/new?${url}`, {
      method: "PUT",
    });
    const target_info = await response.json();

    const ws_url = target_info.webSocketDebuggerUrl;
    if (!ws_url) {
      throw new BrowserError("Failed to get WebSocket URL for new tab");
    }

    const tab = new Tab(ws_url, target_info, this.proxyAuth, this._user_agent, {
      vendor: this.webglVendor,
      renderer: this.webglRenderer,
    });
    await tab.connect();
    this._tabs.push(tab);
    return tab;
  }

  async getTabs(): Promise<Record<string, any>[]> {
    const response = await fetch(`http://127.0.0.1:${this._debug_port}/json`);
    return response.json();
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
          if (typeof data["User-Agent"] === "string") {
            this._user_agent = strip_headless_ua(data["User-Agent"]);
          }
          return data.webSocketDebuggerUrl;
        }
      } catch {
      }

      await delay(200);
    }

    throw new BrowserError("Timeout waiting for Chrome to start");
  }

  private _seed_profile(): void {
    if (!this.userDataDir) {
      return;
    }

    try {
      const profile = new ProfileManager({ profileDir: this.userDataDir });
      profile.seedHistory();
      profile.seedCookies();
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