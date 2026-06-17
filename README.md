# Browser Scraper — Undetected CDP Browser Automation & Stealth Web Scraping for Node.js

**Stealth web scraping and undetected browser automation for Node.js — a CDP-first Puppeteer / Playwright alternative that drives real Chrome without tripping the automation tells that get headless browsers blocked. Bypass Cloudflare Turnstile, pierce closed Shadow DOM, keep one coherent fingerprint. TypeScript-native.**

[![npm version](https://img.shields.io/npm/v/@eurafaeldecarvalho/browser-scraper.svg)](https://www.npmjs.com/package/@eurafaeldecarvalho/browser-scraper)
[![npm downloads](https://img.shields.io/npm/dm/@eurafaeldecarvalho/browser-scraper.svg)](https://www.npmjs.com/package/@eurafaeldecarvalho/browser-scraper)
[![node](https://img.shields.io/node/v/@eurafaeldecarvalho/browser-scraper.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@eurafaeldecarvalho/browser-scraper.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/eurafaeldecarvalho)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/eurafaeldecarvalho)

`@eurafaeldecarvalho/browser-scraper` is a stealth, undetected browser-automation library for **web scraping** the sites that block bots — Cloudflare Turnstile, reCAPTCHA v3, DataDome — built as a CDP-first **Puppeteer / Playwright alternative**. It drives Chrome directly over the DevTools Protocol (CDP) and is built around *not* sending `Runtime.enable` — that call alone is one of the most widely fingerprinted bot signals — while keeping every layer of the browser's identity telling the same story.

What you get over a stock Puppeteer/Playwright setup:

- **No `Runtime.enable` leak.** JavaScript runs through `Page.createIsolatedWorld` + `Runtime.evaluate` — plain commands that never enable the Runtime domain, so the Runtime-domain-dependent signals (`Runtime.consoleAPICalled` and friends) never fire.
- **One `find()` that pierces everything.** Closed shadow roots and cross-origin (OOP) iframes are searched automatically in a single call. No manual frame handling, no `shadowRoot` walking.
- **A fingerprint that doesn't contradict itself.** User-Agent, Client Hints, WebGL, timezone, and locale are all derived from one resolved UA, so the layers can't disagree — and a cross-layer mismatch is the highest-signal tell there is.
- **Human input by default.** Mouse paths follow a min-jerk velocity profile with tremor and overshoot; typing uses lognormal dwell/flight timing. You don't opt in — it's how `click()` and `type()` already behave.

## Passes the bot detectors people actually use

With the right setup — a clean residential/mobile IP, plus a real GPU (EC2 `g4dn`/`g5`) for render-hash targets — `browser-scraper` is built to clear the fingerprint suites and anti-bot stacks that block headless automation:

| Detection / fingerprint suite | | Anti-bot / WAF vendor | |
| --- | :---: | --- | :---: |
| `bot.sannysoft.com` — 0 failures | ✅ | Cloudflare (Turnstile) | ✅ |
| CreepJS — 0% headless, 0% stealth | ✅ | DataDome | ✅ |
| `bot-detector.rebrowser.net` | ✅ | Kasada | ✅ |
| Pixelscan | ✅ | Akamai Bot Manager | ✅ |
| IPHey | ✅ | PerimeterX / HUMAN | ✅ |
| Browserscan | ✅ | Imperva (Incapsula) | ✅ |
| Incolumitas | ✅ | Shape / F5 | ✅ |
| Fingerprint.com | ✅ | AWS WAF Bot Control | ✅ |

> **A ✅ means the fingerprint + behavior layer passes — it is not a guaranteed bypass.** Against hard targets your **IP reputation is the ceiling**: a datacenter ASN loses before the JavaScript runs, so route through a residential/mobile proxy. `browser-scraper` is **not** a CAPTCHA solver — for reCAPTCHA v2 / hCaptcha / Arkose (FunCaptcha) image challenges, pair it with a solver service. It *does* keep reCAPTCHA **v3** scores high via human-like input and warmed profiles.

> Numbers were taken on a desktop Chrome. On a GPU-less Lambda running **chrome-headless-shell** (`@sparticuz/chromium`) the surfaces differ — re-run the suites against your *actual* production binary and treat that as the source of truth (see [Cloud deployment](#cloud-deployment-lambda-vs-ec2-gpu)).

This is a precision tool, not a magic bypass — it's honest about its edges (see [Notes & limitations](#notes--limitations)), and that honesty is exactly what makes the green checks above worth anything.

---

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [The tour](#the-tour) — what it does, by example
  - [Pierce closed Shadow DOM + cross-origin iframes](#pierce-closed-shadow-dom-and-cross-origin-iframes-with-one-find)
  - [Wait for the right moment](#wait-for-the-right-moment)
  - [Interact like a human](#interact-like-a-human)
  - [Control the network](#control-the-network)
  - [Coherent browser fingerprint](#coherent-browser-fingerprint-user-agent-client-hints-webgl-timezone)
  - [Persistent profiles & warming](#persistent-profiles--warming)
- [API reference](#api-reference)
- [Stealth, in depth](#stealth-in-depth)
- [WebGL / GPU on cloud hosts](#webgl--gpu-on-cloud-hosts)
- [Cloud deployment (Lambda vs EC2-GPU)](#cloud-deployment-lambda-vs-ec2-gpu)
- [Identity & persistence](#identity--persistence)
- [WebRTC](#webrtc)
- [Alternatives — how it compares](#alternatives--how-it-compares)
- [FAQ](#faq)
- [Notes & limitations](#notes--limitations)
- [Support](#support)

---

## Install

```bash
npm install @eurafaeldecarvalho/browser-scraper
```

or:

```bash
pnpm add @eurafaeldecarvalho/browser-scraper
```

If `pnpm` blocks native build scripts, run:

```bash
pnpm rebuild better-sqlite3 esbuild
```

Requires Node.js ≥ 20 and a local Chrome/Chromium (it's found automatically, or point at one with `chromePath`). For AWS Lambda, also install the optional `@sparticuz/chromium` — see [Cloud deployment](#cloud-deployment-lambda-vs-ec2-gpu).

## Quickstart

```ts
import { Browser } from "@eurafaeldecarvalho/browser-scraper";

const browser = new Browser();

try {
  const tab = await browser.newTab();
  await tab.goto({ url: "https://example.com" });

  const heading = await tab.find({ selector: "h1" });
  console.log(await heading?.text());

  await tab.screenshot({ path: "example.png" });
} finally {
  await browser.close();
}
```

That's the whole shape of the library: a `Browser`, a `Tab`, and `Element`s you find and act on. Everything below is detail on top of these three.

---

## The tour

A guided look at the pieces you'll reach for most, each shown the way you'd actually use it.

### Pierce closed Shadow DOM and cross-origin iframes with one find()

`find()` is the headline. Give it a CSS selector and it searches the main document, **closed** shadow roots, and **cross-origin iframes** — in one call. The captcha checkbox that lives three layers deep in a sandboxed iframe is found exactly the same way a top-level `<h1>` is.

```ts
// Reaches into a closed shadow root or an OOP iframe automatically — no frame plumbing.
const checkbox = await tab.find({ selector: "input[type='checkbox']", timeout: 12_000 });
await checkbox?.click();

// Returns null on timeout instead of throwing, so branching is clean:
const banner = await tab.find({ selector: ".cookie-banner", timeout: 2_000 });
if (banner) await banner.click();

// Collect every match (also shadow- and iframe-aware):
const links = await tab.findAll({ selector: "a[href]" });
for (const link of links) console.log(await link.getAttribute({ name: "href" }));
```

### Wait for the right moment

Real pages settle in stages. Pick the condition that matches what you're actually waiting for instead of sleeping and hoping.

```ts
// Navigation: same waitUntil names as Puppeteer — load | domcontentloaded | networkidle0 | networkidle2
await tab.goto({ url, waitUntil: "networkidle2", timeout: 45_000 });

// "ready" = visible AND interactable (enabled, not busy) — the state you want before a click
await tab.waitForSelector({ selector: "button.submit", state: "ready", timeout: 30_000 });

// Arbitrary page predicate
await tab.waitForFunction({ expression: "window.__APP_READY__ === true" });

// Whichever finishes first — selector appears, or a JS condition flips. Great for success-or-challenge forks:
const winner = await tab.race({
  selectors: [".dashboard"],
  jsFunctions: ["document.querySelector('.captcha') !== null"],
  timeout: 30_000,
});
```

### Interact like a human

Inputs are humanized by default — the realism is in the library, not in your code.

```ts
const button = await tab.find({ selector: "#cta" });
await button?.click();                      // cursor travels a Bézier path, then presses

await button?.click({ humanLike: false });  // opt out: dispatch straight at the target
await button?.click({ removeNewTabTarget: true }); // strip target/formtarget, stay in this tab

const input = await tab.find({ selector: "#email" });
await input?.type({ text: "me@example.com", clear: true });          // real keyDown/keyUp, lognormal timing
await input?.type({ text: "me@example.com", typos: true });          // opt-in: occasional misstroke + self-correct

// Ambient motion before a token-minting call (grecaptcha.execute) or a high-value submit:
// a "blind execute" with no prior pointer/scroll activity tanks a reCAPTCHA v3 score.
await tab.ambientActivity({ durationMs: 1200 });
```

`type()` and `pressKey()` send genuine `keyDown`/`keyUp` events with correct `keyCode`/`code`, so named keys (`Enter`, `Tab`, `ArrowDown`) behave like a real keyboard rather than a synthetic `value` poke.

### Control the network

Cut metered-proxy bandwidth, kill trackers, or rewrite requests — without breaking the page in a way that itself looks like a bot.

```ts
// Block by HOST so the page still renders normally — safest near anti-bot/captcha,
// which read a broken page as a bot signal:
await tab.blockResources({ urls: ["*googletagmanager.com*", "*adobeaemcloud.com*"] });

// Or block whole resource types to trim bandwidth:
await tab.blockResources({ types: ["Image", "Media", "Font"] });

// Full control: inspect each request and decide:
tab.network.intercept({
  pattern: "*",
  resourceType: "Image",
  handler: async (req) => {
    if (req.url.includes("keep-me")) return req.continueRequest();
    await req.abort({ reason: "BlockedByClient" });
  },
});

// Just watch the traffic go by:
tab.network.on({ event: "response", handler: (res) => console.log(res.status, res.url) });
```

Blocking composes cleanly with an authenticated proxy: a single `Fetch.enable` carries both the proxy credentials and your block rules, so neither clobbers the other.

### Coherent browser fingerprint (User-Agent, Client Hints, WebGL, timezone)

The strongest fingerprint defense isn't any single spoof — it's that nothing contradicts anything else. Set the persona once and every layer follows.

```ts
const browser = new Browser({
  geoCountry: "BR",       // sets timezone + locale + Accept-Language together, in sync
  spoofWebGL: true,       // OS-coherent WebGL string derived from the UA (soft targets)
  proxy: "http://user:pass@residential-proxy:8000",
});

// Or adjust a live tab — one call keeps language, navigator.languages,
// Accept-Language, and timezone consistent. Match it to your proxy's region:
await tab.emulateLocale({ locale: "pt-BR", timezone: "America/Sao_Paulo" });
```

Don't know the proxy's exit country in advance? Set `autoGeo: true` and the first `newTab()` looks it up *through the proxy* and configures geo for you.

### Persistent profiles & warming

reCAPTCHA v3 scores reputation, and a throwaway profile has none. Keep one identity, on one sticky IP, and warm it so the servers mint real cookies.

```ts
import { Browser, ProfileStore, warmProfile } from "@eurafaeldecarvalho/browser-scraper";

const store = new ProfileStore({ baseDir: "/mnt/efs/profiles" }); // EFS, or sync to S3 between runs
const browser = new Browser({
  userDataDir: store.dirFor("identity-42"),
  proxy: "http://user:pass@sticky-residential:8000",
  geoCountry: "BR",
});

const tab = await browser.newTab();
await warmProfile(tab); // genuine navigations + ambient motion so cookies/history accrue
```

One identity, one sticky IP, one fingerprint — a warmed profile behind a *rotating* datacenter IP earns nothing.

---

## API reference

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

await browser.newTab({ url: "about:blank" });
await browser.checkEgress();  // optional: report exit IP ASN + hosting flag
await browser.close();
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

---

## Stealth, in depth

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

## WebGL / GPU on cloud hosts

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

## Cloud deployment (Lambda vs EC2-GPU)

> **The dominant signal is your IP, not your fingerprint.** A flawless headless Chrome on an AWS egress IP still scores low on reCAPTCHA v3 and gets challenged by Cloudflare/DataDome, because datacenter ASNs are penalized *before your JavaScript runs*. Route protected targets through a **residential or mobile proxy** — [IPRoyal][iproyal] is the cheapest residential pool I've found that still gets through (paid link); [Bright Data][brightdata] is the premium option for the hardest targets. The library warns on direct egress (`warnOnDirectEgress`) and `browser.checkEgress()` reports whether your exit IP is flagged as hosting.

**Lambda — ZIP runtime + `@sparticuz/chromium` (the supported path).** Real `google-chrome-stable` does **not** run on the Lambda ZIP runtime: it dies under Firecracker's namespace/seccomp sandbox even single-process (`credentials.cc Operation not permitted`, "Zygote could not fork"), and a full Chrome won't fit the ~250 MB unzipped zip limit. Use **`@sparticuz/chromium`** (an *optional* dependency — install + pin it, and keep it **`external`** in your bundler so it resolves its binary by relative path). It ships **chrome-headless-shell**, which is already headless (`--headless='shell'`); the lib detects that via `channel:'headless-shell'` and: never adds `--headless=new`, owns the software-WebGL flags, ensures `HOME`/`XDG_*`/user-data dirs exist under `/tmp`, points `DBUS_SESSION_BUS_ADDRESS` at `/dev/null`, and auto-applies the shell shims (`window.chrome`, `navigator.connection`) that a real headful Chrome has natively.

```ts
import { Browser, resolveSparticuz } from "@eurafaeldecarvalho/browser-scraper";

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

## Identity & persistence

A fresh temp profile every run accrues no reputation, and **forged Google/`_GRECAPTCHA` cookies buy nothing** (Google mints and validates them server-side — the seeder no longer fabricates them). For reCAPTCHA-v3-gated targets, keep a **persistent per-identity profile** pinned to one sticky proxy IP and warm it so the servers mint real cookies:

```ts
import { Browser, ProfileStore, warmProfile } from "@eurafaeldecarvalho/browser-scraper";

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

## WebRTC

WebRTC is left enabled (fully disabling it is itself an anomaly) but locked down to prevent IP leaks: behind a proxy it forces all UDP through the proxy (`disable_non_proxied_udp`); otherwise it exposes only the public interface and hides local IPs (`default_public_interface_only`).

## Alternatives — how it compares

If you're shopping for an **undetected Puppeteer / Playwright alternative**, here's where this library sits. It targets the same job as stock Puppeteer + `puppeteer-extra-plugin-stealth` or `puppeteer-real-browser`, but starts from raw CDP instead of patching a high-level driver after the fact.

| Capability | Puppeteer / Playwright | + puppeteer-extra-plugin-stealth | puppeteer-real-browser | **browser-scraper** |
| --- | :---: | :---: | :---: | :---: |
| Transport | high-level API (enables `Runtime`) | same + JS patches | real Chrome + patches | **raw CDP** |
| `Runtime.enable` leak | present | patched | mitigated | **never sent** (isolated-world exec) |
| Pierce **closed** Shadow DOM in one call | ✗ | ✗ | ✗ | **✓ `find()`** |
| Cross-origin iframe in the same `find()` | ✗ (manual frames) | ✗ | ✗ | **✓** |
| Coherent persona (UA + Client-Hints + WebGL + timezone from one UA) | ✗ | partial | partial | **✓** |
| Human input (min-jerk mouse, lognormal typing) | ✗ | ✗ (add `ghost-cursor`) | partial | **✓ built-in** |
| AWS Lambda / chrome-headless-shell path | manual | manual | ✗ | **✓ `resolveSparticuz()`** |

This is a precision tool, not a magic captcha bypass: against hard targets (Cloudflare, DataDome, Kasada) your **IP reputation** still dominates — pair it with a residential/mobile proxy (see [Cloud deployment](#cloud-deployment-lambda-vs-ec2-gpu)).

## FAQ

### How do I make Puppeteer undetected / pass bot detection in Node.js?
The detectable tells are the `Runtime.enable` CDP leak, the `HeadlessChrome` User-Agent/client-hints, and cross-layer fingerprint mismatches. This library avoids `Runtime.enable` entirely (all JS runs via `Page.createIsolatedWorld` + `Runtime.evaluate`), strips the headless UA, and derives one coherent persona — see [Stealth, in depth](#stealth-in-depth). Verified against `bot.sannysoft.com` (0 failures), CreepJS (0% headless), and `bot-detector.rebrowser.net`.

### How do I bypass Cloudflare Turnstile in Node.js?
The Turnstile checkbox usually lives inside a sandboxed, cross-origin iframe. A single `find()` reaches it (and any closed shadow root) so you can `click()` it like a real user — see [Pierce closed Shadow DOM + cross-origin iframes](#pierce-closed-shadow-dom-and-cross-origin-iframes-with-one-find) and the `examples/cloudflare-turnstile.ts` example. Behind a clean residential IP this passes Cloudflare's interstitial; the IP, not the click, is the dominant factor.

### How do I access or query a closed Shadow DOM?
Puppeteer and Playwright [cannot pierce **closed** shadow roots](https://github.com/microsoft/playwright/issues/23047). `find()` / `findAll()` search the main document, closed shadow roots, and cross-origin (OOP) iframes in one call — no `shadowRoot` walking, no frame plumbing.

### What is the `Runtime.enable` CDP detection leak, and how is it avoided?
Calling `Runtime.enable` (which most automation stacks do at startup) triggers Runtime-domain signals like `Runtime.consoleAPICalled` that anti-bot vendors fingerprint. This library never enables the Runtime domain — execution happens in a named isolated world via `Runtime.evaluate`, which doesn't.

### How do I run headless Chrome on AWS Lambda for scraping?
Use the optional `@sparticuz/chromium` build and `resolveSparticuz()`; the library detects chrome-headless-shell and applies the right flags, dirs, and shims automatically — see [Cloud deployment (Lambda vs EC2-GPU)](#cloud-deployment-lambda-vs-ec2-gpu).

### Puppeteer vs Playwright for stealth scraping — which should I use?
Both are high-level drivers that enable the `Runtime` domain and can't pierce closed shadow roots, so for detection-sensitive scraping you end up bolting on stealth plugins. This library is the CDP-first alternative built for that case from the start — see [Alternatives](#alternatives--how-it-compares).

### Does it solve CAPTCHAs or reCAPTCHA v3?
It does not solve image/token CAPTCHAs. What it does is keep your reCAPTCHA **v3 score** high — human-like mouse/typing, ambient activity before a token-minting call, and a warmed persistent profile on a sticky residential IP — see [Identity & persistence](#identity--persistence). For v2 image challenges, pair it with a solver service.

## Notes & limitations

- The port mirrors the real implemented behavior in the Python package, plus the stealth and emulation additions described above.
- No JavaScript fingerprint spoofing is injected by default on a normal desktop Chrome: native behavior is harder to detect than patched APIs. The stealth gains come from avoiding `Runtime.enable`, cleaning the headless UA/client-hints, generic world names, careful launch flags, and human-like input. Bring your own patches via `tab.addInitScript` if a target needs them.
- **Under `channel:'headless-shell'`** the lib applies a small set of **conditional** shims that close two specific shell-only tells — it does **not** claim to make the shell binary indistinguishable from a real headful Chrome. The shims, each a no-op when the value is already real and written to match Chrome's native descriptor shape (enumerable own data property for `window.chrome`; prototype accessors with native-looking `toString` for `navigator.connection`): a minimal `window.chrome`/`chrome.runtime` (only when missing) and a non-zero `navigator.connection.rtt` (only when it reads `0`). Residual shell gaps are deliberately left untouched (a fabricated `navigator.plugins`/WebGPU adapter is itself a tell — see the research doc) and remain soft-target limitations; the dominant lever stays the IP. The lib also threads the **real, live GREASE brand** (read from `navigator.userAgentData`) into the Client-Hints instead of a hard-coded value that rotates stale, and **verifies a WebGL context exists before installing the WebGL string spoof** (a `getParameter`-only spoof is inert — and incoherent — with no context behind it; against render-hash anti-bots like DataDome Picasso it's worse than honest, so keep `spoofWebGL` for soft targets only).
- WebGL string spoofing is for **soft targets only** — it can't beat a forced render-hash. For hard targets, run a real GPU.
- The dominant signal is your **IP reputation**, not your fingerprint. Datacenter ASNs lose before the JavaScript runs; route protected targets through a residential/mobile proxy ([IPRoyal][iproyal] on a budget, [Bright Data][brightdata] for hard targets — paid links).
- **This library doesn't solve captchas — by design.** Its posture is IP reputation + human-like behavior, not token forging (forged `_GRECAPTCHA` tokens buy nothing). If a target throws an interactive image/checkbox challenge you genuinely must clear, hand it to a solving service — [2Captcha][2captcha] or [Anti-Captcha][anticaptcha] (paid links). Fix your IP first: a solver on a flagged datacenter IP still loses.

## Support

This library is built and maintained in the open. If it saved you the work of fighting `Runtime.enable` leaks, shadow-DOM traversal, and fingerprint coherence yourself, a small contribution keeps the development going:

- **[Sponsor on GitHub](https://github.com/sponsors/eurafaeldecarvalho)** — one-time or monthly
- **[Buy me a coffee on Ko-fi](https://ko-fi.com/eurafaeldecarvalho)** — quick one-off tip

Starring the repo helps too — it's how other developers find the project.

> Some proxy and captcha links in this README are paid links — I may earn a commission at no extra cost to you. They're tools I'd route my own traffic through.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE). Free for noncommercial use; contact the author for a commercial license.

[iproyal]: https://iproyal.com/?r=eurafaeldecarvalho
[brightdata]: https://brightdata.com
[2captcha]: https://2captcha.com/auth/register/?from=12417190
[anticaptcha]: https://getcaptchasolution.com/yykljfdcin
