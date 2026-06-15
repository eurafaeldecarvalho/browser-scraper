# Browser Scraper

`@rafaelgdn/browser-scraper` is a CDP-first browser scraping package for Node.js, preserving the same public API and the same design direction used in the original GDNox prototype.

## Status

This package has the core ported:

- Direct Chrome launch with raw CDP
- Tab/page control and history navigation (`back`, `forward`, `reload`)
- Unified DOM search with shadow root piercing
- OOP iframe support
- Element interactions with human-like mouse and real keyboard events
- Network monitoring and interception
- Profile seeding
- Emulation helpers (viewport, geolocation, timezone, locale, extra headers, init scripts)
- Stealth hardening that avoids the `Runtime.enable` automation leak

## Stealth

> **Background research:** how reCAPTCHA v3/Enterprise and the anti-bot vendors (Cloudflare, DataDome/Picasso, PerimeterX/HUMAN, Kasada, Akamai, Imperva, securiti.ai, Arkose, hCaptcha) actually detect bots — with the signal-layer taxonomy and the design rationale behind every choice below — is documented in [`docs/antibot-and-captcha-research.md`](docs/antibot-and-captcha-research.md).

The library is built to minimize the signals anti-bot vendors (Cloudflare, DataDome, Kasada) look for:

- **No `Runtime.enable`.** All JavaScript runs through `Page.createIsolatedWorld` + `Runtime.evaluate`, plain commands that do not enable the Runtime domain. Context invalidation is handled via `Page.frameNavigated` and stale-context retries. *(Calibration: the best-known probe — the `Error.stack`-getter triggered during inspector serialization — was largely defused by V8's May-2025 patches, so this is no longer the single dominant tell it once was; but avoiding `Runtime.enable` still defeats the other Runtime-domain-dependent signals, e.g. `Runtime.consoleAPICalled`, so it remains a correct invariant.)*
- **Clean User-Agent + client hints.** In `--headless=new`, Chrome injects `HeadlessChrome` into the UA and `sec-ch-ua`. The library strips it and applies matching `userAgentMetadata` so `navigator.userAgentData` stays consistent.
- **Generic isolated-world names** (`util`) instead of identifiable ones.
- **Launch flags** avoid options whose mere presence is a fingerprint (`--disable-popup-blocking`, `--disable-component-update`, `--disable-extensions`, `--enable-automation`).
- **Human-like input.** Mouse moves follow a min-jerk velocity profile with distance-scaled timing, in-flight tremor and ballistic overshoot+correction; typing uses lognormal dwell/flight times with occasional key rollover. `tab.mouse.idle()` adds non-periodic ambient cursor drift (useful before a `grecaptcha.execute()`).
- **Coherent persona.** UA string, Client-Hints (`platform`, `platformVersion`, real `fullVersionList`, `architecture`), WebGL identity, and geo (timezone/locale/`Accept-Language`) are all derived from one resolved User-Agent so the layers can't contradict each other — a cross-layer mismatch is the highest-signal tell.

A small set of **conditional, defensive** JS patches is injected by default (toggle with `evasions: false`): `navigator.webdriver` is forced to a present `false` getter only if the launch flag didn't already do it; `Notification.permission` is reconciled with `navigator.permissions.query` (the real `PermissionStatus` is returned with only its `state` mapped, so `default` → the valid `prompt`); and `window.screen`/`outerWidth` are normalized into a coherent maximized-window geometry when a `screen`/`windowSize` is set. Each patch keeps its `toString()` native and no-ops when the value was already fine (over-patching a correct value is itself a tell). `navigator.hardwareConcurrency` is set engine-level via CDP so it stays consistent inside workers; `deviceMemory` is deliberately **not** spoofed (a main-world-only override would desync from workers — a stronger tell). Add your own with `tab.addInitScript({ source })`.

Audited against `bot-detector.rebrowser.net` (no `runtimeEnableLeak`, no `navigatorWebdriver`, isolated-world execution), `bot.sannysoft.com` (0 failures), and CreepJS (0% headless, 0% stealth).

> **Re-measure on your production binary.** Those results were taken on a desktop Chrome. On a GPU-less Lambda running **chrome-headless-shell** (`@sparticuz/chromium`) the surfaces differ — `window.chrome`/`navigator.plugins` absence, SwiftShader WebGL, codecs — which is exactly what `channel:'headless-shell'` shims. Re-run the suites against the *actual* sparticuz binary and treat that as the source of truth.

### WebGL / GPU on cloud hosts

On your machine WebGL reports your real GPU. On a **GPU-less cloud server, Chrome falls back to SwiftShader/llvmpipe**, and `SwiftShader` / `llvmpipe` in the renderer is a known headless signal. But the spoof has two sharp edges you must respect:

1. **Never claim an OS the renderer can't belong to.** A `Direct3D11`/`D3D11` renderer string exists **only on Windows**. Emitting it under a Linux UA is an *impossible* combination that DataDome/Picasso hard-blocks — strictly worse than the honest software string. `spoofWebGL: true` now derives an **OS-coherent** default from the resolved UA (Linux→Mesa/ANGLE OpenGL, Windows→D3D11, macOS→Metal); it will never put a Windows GPU on a Linux UA.
2. **A `getParameter`-only spoof can't beat a forced render.** The override changes the vendor/renderer *strings*, but the extension list, parameter limits, and the actual rendered pixel hash still come from SwiftShader. Top-tier antibots (DataDome Picasso, Cloudflare, Kasada) force a render and cross-check, so a discrete-GPU string under software rendering is detectable. **The spoof is for soft targets only.**

```ts
// Soft targets: an OS-coherent default derived from the UA (Linux => Mesa string)
const browser = new Browser({ headless: true, spoofWebGL: true });

// Or pick exact strings (must match your UA's OS)
const browser = new Browser({
  webglVendor: "Google Inc. (Intel)",
  webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1) (0x00009A60), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
});
```

**Decision guide for the Lambda / Linux + `--headless=new` target:**

- **Hard targets (DataDome/Cloudflare/Kasada):** a string spoof will not survive a render-hash. Run a **real GPU** (EC2 `g4dn`/`g5` + NVIDIA driver) and **turn the spoof OFF** — let WebGL report the genuine, internally-coherent hardware. This is the only configuration that passes Picasso.
- **Soft targets:** `spoofWebGL: true` (coherent Linux string) is fine.

In `--headless=new`, the library always adds `--enable-unsafe-swiftshader`: Chrome 137+ removed the automatic software-WebGL fallback, so without it `getContext('webgl')` returns `null` on a GPU-less host — itself a tell, and it makes any spoof inert. With a real GPU present, the GPU is still used.

The override runs in the page's main world and keeps `getParameter.toString()` native-looking. Known limitation: it targets the main thread, not Web Workers/OffscreenCanvas.

### Cloud deployment (AWS Lambda vs EC2-GPU)

> **The dominant signal is your IP, not your fingerprint.** A flawless headless Chrome on an AWS egress IP still scores low on reCAPTCHA v3 and gets challenged by Cloudflare/DataDome, because datacenter ASNs are penalized *before your JavaScript runs*. Route protected targets through a **residential or mobile proxy**. The library warns on direct egress (`warnOnDirectEgress`) and `browser.checkEgress()` reports whether your exit IP is flagged as hosting.

**Lambda — ZIP runtime + `@sparticuz/chromium` (the supported path).** Real `google-chrome-stable` does **not** run on the Lambda ZIP runtime: it dies under Firecracker's namespace/seccomp sandbox even single-process (`credentials.cc Operation not permitted`, "Zygote could not fork"), and a full Chrome won't fit the ~250 MB unzipped zip limit. Use **`@sparticuz/chromium`** (an *optional* dependency — install + pin it, and keep it **`external`** in your bundler so it resolves its binary by relative path). It ships **chrome-headless-shell**, which is already headless (`--headless='shell'`); the lib detects that via `channel:'headless-shell'` and: never adds `--headless=new`, owns the software-WebGL flags, ensures `HOME`/`XDG_*`/user-data dirs exist under `/tmp`, points `DBUS_SESSION_BUS_ADDRESS` at `/dev/null`, and auto-applies the shell shims (`window.chrome`, `navigator.connection`) that a real headful Chrome has natively.

```ts
import { Browser, resolveSparticuz } from "@rafaelgdn/browser-scraper";

const browser = new Browser({
  chromium: await resolveSparticuz(), // executablePath + Lambda args; implies channel:'headless-shell'
  proxy: "http://user:pass@residential-proxy:8000",
  geoCountry: "BR",                   // timezone + locale + Accept-Language, matched to the proxy exit
  onStderr: (chunk) => console.error(chunk), // optional: live Chrome stderr (OOM/seccomp cause)
});
```

> This is a marginal anti-bot trade-off (chrome-headless-shell + SwiftShader, no proprietary codecs), accepted because for reCAPTCHA v3 **IP reputation dominates**. A full-Chromium `--headless=new` build is **not** worth packaging: it won't fit the zip, dies on Firecracker, and its worst tells (SwiftShader WebGL, no GPU) come from the GPU-less host, not the headless mode — so they're identical to the shell. Size the function's `/tmp` (ephemeral storage) beyond the 512 MB default: the binary extracts ~130 MB there, plus the user-data profile.

`geoCountry` must match the proxy's exit country (a UTC clock or `pt-BR` locale on a German IP is a hard tell). If you don't know it ahead of time, set `autoGeo: true` instead of `geoCountry` and the first `newTab()` will look up the exit country **through the proxy** and set it for you (one extra request at startup; explicit `geoCountry`/`timezone`/`locale` always win, and an unmapped country warns rather than guessing).

**EC2 `g4dn`/`g5` (real NVIDIA GPU):** the posture for hard targets. Verify the GPU at `chrome://gpu`, leave `spoofWebGL` **off**, and still use a residential/mobile proxy.

### Identity & persistence

A fresh temp profile every run accrues no reputation, and **forged Google/`_GRECAPTCHA` cookies buy nothing** (Google mints and validates them server-side — the seeder no longer fabricates them). For reCAPTCHA-v3-gated targets, keep a **persistent per-identity profile** pinned to one sticky proxy IP and warm it so the servers mint real cookies:

```ts
import { Browser, ProfileStore, warmProfile } from "@rafaelgdn/browser-scraper";

const store = new ProfileStore({ baseDir: "/mnt/efs/profiles" }); // EFS, or sync to S3 between runs
const browser = new Browser({
  userDataDir: store.dirFor("identity-42"),
  proxy: "http://user:pass@sticky-residential:8000",
  geoCountry: "BR",
});
const tab = await browser.newTab();
await warmProfile(tab); // genuine navigations + ambient motion so cookies/history accrue
```

A warmed profile behind a *rotating* datacenter IP earns nothing — one identity, one sticky IP, one fingerprint.

> **Inject warmed cookies via CDP, not the SQLite file.** `ProfileManager.seedCookies()` (the pre-launch SQLite write) is **inert on Chrome ≥ 80**: Chrome reads the OSCrypt-encrypted `encrypted_value` and ignores the plaintext `value`, so file-seeded cookies are dropped at load (auto-seed now only seeds *history*, which the SQLite path handles fine). To inject a warmed cookie bundle that actually sticks, set it at runtime through Chrome's own (encrypted) store: `await tab.setCookies({ cookies })` — encrypted with the live profile key. `ProfileManager.cookieSeeds()` returns the default low-key bundle. Pin each bundle to the same sticky residential IP it was warmed on.

### WebRTC

WebRTC is left enabled (fully disabling it is itself an anomaly) but locked down to prevent IP leaks: behind a proxy it forces all UDP through the proxy (`disable_non_proxied_udp`); otherwise it exposes only the public interface and hides local IPs (`default_public_interface_only`).

## Install

```bash
npm install @rafaelgdn/browser-scraper
```

or:

```bash
pnpm add @rafaelgdn/browser-scraper
```

If `pnpm` blocks native build scripts, run:

```bash
pnpm rebuild better-sqlite3 esbuild
```

## Usage

```ts
import { Browser } from "@rafaelgdn/browser-scraper";

const browser = new Browser();

try {
  const tab = await browser.newTab();
  await tab.goto({ url: "https://example.com" });

  const heading = await tab.find({ selector: "h1" });
  console.log(await heading?.text());
} finally {
  await browser.close();
}
```

## API

### Browser

```ts
new Browser({
  chromePath: null,
  headless: false,
  userDataDir: null,
  proxy: null,            // http(s):// or socks5:// (auth only on http(s) — Chrome can't auth SOCKS)
  extraArgs: [],
  autoSeed: true,

  // --- stealth / persona (all derived coherently from the resolved UA) ---
  userAgent: null,        // override the UA for the WHOLE persona (WebGL OS default,
                          // Client-Hints, platform) and apply it via --user-agent at launch.
                          // Keep the Chrome major matching the host build.
  spoofWebGL: false,      // OS-coherent WebGL identity (soft targets only; off on real GPU)
  webglVendor: null,      // explicit override (must match the UA's OS)
  webglRenderer: null,
  geoCountry: null,       // ISO-2, e.g. "BR" => timezone + locale + Accept-Language together
  autoGeo: false,         // detect the proxy exit country at first newTab() and set geoCountry
  timezone: null,         // explicit overrides for the above
  locale: null,
  acceptLanguage: null,
  hardwareConcurrency: null, // engine-level (propagates to workers)
  screen: null,           // { width, height } => device-metrics + window.screen/outerWidth
  windowSize: null,       // { width, height } => --window-size (defaults to screen or 1920x1080)
  evasions: true,         // webdriver / Notification / screen init scripts
  lambda: false,          // adds --no-sandbox --disable-dev-shm-usage for containers
  warnOnDirectEgress: true,  // warn once when launching with no proxy

  // --- Lambda / chrome-headless-shell (@sparticuz/chromium) ---
  channel: null,          // "headless-shell" => binary is chrome-headless-shell:
                          // never add --headless=new, own the software-WebGL flags,
                          // ensure HOME/XDG/user-data dirs, DBUS=/dev/null, and
                          // auto-apply the shell shims (window.chrome, connection).
  chromium: null,         // pre-resolved { executablePath, args, shellMode } from
                          // `await resolveSparticuz()`; implies channel:"headless-shell".
  onStderr: null,         // (chunk) => void : receive Chrome's stderr live. Even
                          // without it, stderr is captured and attached to the
                          // BrowserError on a launch timeout (real crash cause).
  screenCoordOffset: null,// OPT-IN { x, y }: MouseEvent.screenX/screenY = clientX+x /
                          // clientY+y to counter the CDP screenX==clientX artifact.
                          // VERIFY on your exact binary first (a ~Sep-2025 Chromium
                          // fix may already report correct coords).
});

// await browser.checkEgress();  // optional: report exit IP ASN + hosting flag
```

> **Known hardening gap (not addressed):** the library exposes CDP over a TCP `--remote-debugging-port` bound to `127.0.0.1`. A same-origin in-page probe of `localhost` cannot be fully blocked by the random port. Closing it requires switching the whole transport to `--remote-debugging-pipe` (fd 3/4), which removes the HTTP `/json/*` endpoints and collapses the per-tab WebSocket model into one session-multiplexed connection — a deep, isolated transport rewrite. It is deliberately left as a separate change rather than shipped half-done; it is a low-severity vector (random port + localhost bind already mitigate remote scanning).

### Tab

```ts
await tab.goto({ url, waitUntil: "load", timeout: 30_000 });
await tab.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 });
await tab.find({ selector, timeout: 5_000 });
await tab.findAll({ selector });
await tab.waitForSelector({ selector, state: "attached", timeout: 30_000 });
await tab.waitForSelector({ selector, state: "ready", timeout: 30_000 });
await tab.waitForFunction({ expression, timeout: 30_000 });
await tab.race({ selectors: [".success"], jsFunctions: ["window.done === true"], visible: false, timeout: 30_000 });
await tab.evaluate({ expression: "document.title" });
await tab.screenshot({ path: "shot.png" });
await tab.content();
await tab.sleep({ milliseconds: 2_000 });

// History navigation
await tab.back();
await tab.forward();
await tab.reload();

// Input helpers
await tab.pressKey({ key: "Enter" });
await tab.mouse.moveTo({ x: 200, y: 300 });

// Emulation / stealth
await tab.addInitScript({ source: "/* runs before page scripts */" });
await tab.setUserAgent({ userAgent: "..." });
await tab.setExtraHeaders({ headers: { "Accept-Language": "en-US" } });
await tab.setViewport({ width: 1280, height: 800 });
await tab.setGeolocation({ latitude: -23.55, longitude: -46.63 });
await tab.setTimezone({ timezoneId: "America/Sao_Paulo" });
await tab.setLocale({ locale: "pt-BR" });
// One call that keeps language + navigator.languages + Accept-Language + timezone
// consistent — match this to your proxy's region to avoid a geo mismatch.
await tab.emulateLocale({ locale: "pt-BR", timezone: "America/Sao_Paulo" });
await tab.bringToFront();
await tab.pdf({ path: "page.pdf" });

// Native dialogs (alert/confirm/prompt/beforeunload)
tab.onDialog(async (dialog) => {
  await dialog.accept();
});

// Human-like ambient motion BEFORE a token-minting call (grecaptcha.execute) or a
// high-value submit — a "blind execute" with zero prior pointer/scroll activity
// tanks a reCAPTCHA v3 score.
await tab.ambientActivity({ durationMs: 1200 });

// Inject a warmed cookie bundle via CDP (encrypted with the live profile key —
// unlike the inert SQLite seeding). Each cookie needs a `domain` or `url`.
await tab.setCookies({ cookies: [{ name: "NID", value: "...", domain: ".google.com", secure: true }] });

// Surface a mid-run Chrome death as a typed, recoverable error for THIS run
// (in-flight CDP commands reject immediately instead of hanging to a 30s timeout).
tab.onDisconnect((error) => { /* abort this run gracefully */ });
```

`waitUntil` follows the same public names used by Puppeteer: `load`, `domcontentloaded`, `networkidle0`, and `networkidle2`.
All timeouts and sleeps are expressed in milliseconds.
`waitForSelector({ state: "visible" })` waits only for visibility.
`waitForSelector({ state: "ready" })` waits for visibility plus interactability, including enabled/not-busy checks for common button states.

### Network / request blocking

```ts
// Drop bandwidth-heavy resources (handy to cut metered-proxy traffic).
// Block by HOST to keep the page rendering normally — safest around anti-bot /
// captcha, which read a broken page as a bot signal:
await tab.blockResources({ urls: ["*adobeaemcloud.com*", "*googletagmanager.com*"] });

// Or block whole resource types (Image, Media, Font, Stylesheet). With no proxy
// auth, only the listed types pause at the CDP level — scripts/XHR/documents are
// never intercepted:
await tab.blockResources({ types: ["Image", "Media"] });

// Lower-level equivalents:
await tab.network.block({ patterns: ["*.jpg", "*ads*"], resourceTypes: ["Font"] });
tab.network.intercept({
  pattern: "*",
  resourceType: "Image",
  handler: async (req) => {
    if (req.url.includes("keep-me")) return req.continueRequest();
    await req.abort({ reason: "BlockedByClient" });
  },
});

// Observe traffic:
tab.network.on({ event: "response", handler: (res) => console.log(res.status, res.url) });
```

Request blocking composes with an authenticated proxy: a single `Fetch.enable`
carries both the proxy credential handling and the block rules, so neither
clobbers the other.

### Element

```ts
await element.click();
await element.click({ humanLike: false });
await element.click({ removeNewTabTarget: true });
await element.hover();
await element.type({ text: "hello", clear: true });
await element.pressKey({ key: "Enter" });
await element.text();
await element.innerHtml();
await element.getAttribute({ name: "href" });
await element.setAttribute({ name: "data-test", value: "1" });
await element.getProperty({ name: "value" });
await element.boundingBox();
await element.isVisible();
await element.isChecked();
await element.selectOption({ value: "b" });
await element.setInputFiles({ files: ["/path/to/file.png"] });
await element.screenshot({ path: "element.png" });
```

`click()` is human-like by default: it moves the cursor to the element along a Bézier path before pressing.
`click({ humanLike: false })` dispatches the press/release directly at the resolved target position.
`click({ removeNewTabTarget: true })` removes `target` and `formtarget` before clicking so the action stays in the current tab when possible.
`type()` and `pressKey()` dispatch real `keyDown`/`keyUp` events (correct `keyCode`/`code`), so named keys like `Enter`, `Tab`, and `ArrowDown` work.
`type({ typos: true })` (opt-in, default off) injects occasional adjacent-key misstrokes + self-correction (`Backspace`), which behavioral scorers weight as human. Leave it **off** for fields whose value you assert mid-type or that validate on each keystroke.

## Notes

- The port mirrors the real implemented behavior in the Python package, plus the stealth and emulation additions described above.
- No JavaScript fingerprint spoofing is injected by default on a normal desktop Chrome: native behavior is harder to detect than patched APIs. The stealth gains come from avoiding `Runtime.enable`, cleaning the headless UA/client-hints, generic world names, careful launch flags, and human-like input. Bring your own patches via `tab.addInitScript` if a target needs them.
- **Under `channel:'headless-shell'`** the lib applies a small set of **conditional** shims that close two specific shell-only tells — it does **not** claim to make the shell binary indistinguishable from a real headful Chrome. The shims, each a no-op when the value is already real and written to match Chrome's native descriptor shape (enumerable own data property for `window.chrome`; prototype accessors with native-looking `toString` for `navigator.connection`): a minimal `window.chrome`/`chrome.runtime` (only when missing) and a non-zero `navigator.connection.rtt` (only when it reads `0`). Residual shell gaps are deliberately left untouched (a fabricated `navigator.plugins`/WebGPU adapter is itself a tell — see the research doc) and remain soft-target limitations; the dominant lever stays the IP. The lib also threads the **real, live GREASE brand** (read from `navigator.userAgentData`) into the Client-Hints instead of a hard-coded value that rotates stale, and **verifies a WebGL context exists before installing the WebGL string spoof** (a `getParameter`-only spoof is inert — and incoherent — with no context behind it; against render-hash anti-bots like DataDome Picasso it's worse than honest, so keep `spoofWebGL` for soft targets only).

## Publish

Confirm the next version is not published yet:

```bash
npm view @rafaelgdn/browser-scraper version
```

Build and validate the publishable tarball:

```bash
pnpm run release:check
```

Log into npm:

```bash
npm login
npm whoami
```

Publish the scoped package publicly:

```bash
pnpm publish --access public --no-git-checks
```