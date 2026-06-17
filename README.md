# Browser Scraper

**Drive real Chrome from Node.js without tripping the automation tells that get headless browsers blocked.**

[![npm version](https://img.shields.io/npm/v/@rafaelgdn/browser-scraper.svg)](https://www.npmjs.com/package/@rafaelgdn/browser-scraper)
[![npm downloads](https://img.shields.io/npm/dm/@rafaelgdn/browser-scraper.svg)](https://www.npmjs.com/package/@rafaelgdn/browser-scraper)
[![node](https://img.shields.io/node/v/@rafaelgdn/browser-scraper.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@rafaelgdn/browser-scraper.svg)](./LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/eurafaeldecarvalho)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/eurafaeldecarvalho)

`@rafaelgdn/browser-scraper` talks to Chrome directly over the DevTools Protocol (CDP). Most automation stacks announce themselves the moment they start — the `Runtime.enable` call alone is the single most widely fingerprinted bot signal. This library is built around *not* sending it, and around keeping every layer of the browser's identity telling the same story.

What you get over a stock Puppeteer/Playwright setup:

- **No `Runtime.enable` leak.** JavaScript runs through `Page.createIsolatedWorld` + `Runtime.evaluate` — plain commands that never enable the Runtime domain. This is the tell `rebrowser`, CreepJS, and the commercial vendors check first.
- **One `find()` that pierces everything.** Closed shadow roots and cross-origin (OOP) iframes are searched automatically in a single call. No manual frame handling, no `shadowRoot` walking.
- **A fingerprint that doesn't contradict itself.** User-Agent, Client Hints, WebGL, timezone, and locale are all derived from one resolved UA, so the layers can't disagree — and a cross-layer mismatch is the highest-signal tell there is.
- **Human input by default.** Mouse paths follow a min-jerk velocity profile with tremor and overshoot; typing uses lognormal dwell/flight timing. You don't opt in — it's how `click()` and `type()` already behave.

### Measured against the detectors people actually use

- **`bot.sannysoft.com`** — 0 failures
- **CreepJS** — 0% headless, 0% stealth
- **`bot-detector.rebrowser.net`** — no `runtimeEnableLeak`, no `navigatorWebdriver`, isolated-world execution confirmed

This is a precision tool, not a magic bypass. It's honest about its edges (see [Notes & limitations](#notes--limitations)) — and that honesty is exactly why the claims above hold up.

---

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [The tour](#the-tour) — what it does, by example
  - [Find anything: shadow DOM + iframes](#find-anything-shadow-dom--iframes)
  - [Wait for the right moment](#wait-for-the-right-moment)
  - [Interact like a human](#interact-like-a-human)
  - [Control the network](#control-the-network)
  - [One coherent identity](#one-coherent-identity)
  - [Persistent profiles & warming](#persistent-profiles--warming)
- [API reference](#api-reference)
- [Stealth, in depth](#stealth-in-depth)
- [WebGL / GPU on cloud hosts](#webgl--gpu-on-cloud-hosts)
- [Cloud deployment (Lambda vs EC2-GPU)](#cloud-deployment-lambda-vs-ec2-gpu)
- [Identity & persistence](#identity--persistence)
- [WebRTC](#webrtc)
- [Notes & limitations](#notes--limitations)
- [Support](#support)

---

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

Requires Node.js ≥ 20 and a local Chrome/Chromium (it's found automatically, or point at one with `chromePath`).

## Quickstart

```ts
import { Browser } from "@rafaelgdn/browser-scraper";

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

### Find anything: shadow DOM + iframes

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
await input?.type({ text: "me@example.com", clear: true }); // real keyDown/keyUp, lognormal timing

// Drive the cursor yourself when you need to — e.g. ambient motion before grecaptcha.execute()
await tab.mouse.moveTo({ x: 200, y: 300 });
await tab.mouse.idle();                      // non-periodic drift, no fixed rhythm to detect
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

### One coherent identity

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

---

## Stealth, in depth

The library is built to minimize the signals anti-bot vendors (Cloudflare, DataDome, Kasada) look for:

- **No `Runtime.enable`.** That CDP call is the single most widely used automation tell. All JavaScript runs through `Page.createIsolatedWorld` + `Runtime.evaluate`, which are plain commands that do not enable the Runtime domain. Context invalidation is handled via `Page.frameNavigated` and stale-context retries.
- **Clean User-Agent + client hints.** In `--headless=new`, Chrome injects `HeadlessChrome` into the UA and `sec-ch-ua`. The library strips it and applies matching `userAgentMetadata` so `navigator.userAgentData` stays consistent.
- **Generic isolated-world names** (`util`) instead of identifiable ones.
- **Launch flags** avoid options whose mere presence is a fingerprint (`--disable-popup-blocking`, `--disable-component-update`, `--disable-extensions`, `--enable-automation`).
- **Human-like input.** Mouse moves follow a min-jerk velocity profile with distance-scaled timing, in-flight tremor and ballistic overshoot+correction; typing uses lognormal dwell/flight times with occasional key rollover. `tab.mouse.idle()` adds non-periodic ambient cursor drift (useful before a `grecaptcha.execute()`).
- **Coherent persona.** UA string, Client-Hints (`platform`, `platformVersion`, real `fullVersionList`, `architecture`), WebGL identity, and geo (timezone/locale/`Accept-Language`) are all derived from one resolved User-Agent so the layers can't contradict each other — a cross-layer mismatch is the highest-signal tell.

A small set of **conditional, defensive** JS patches is injected by default (toggle with `evasions: false`): `navigator.webdriver` is forced to a present `false` getter only if the launch flag didn't already do it; `Notification.permission` is reconciled with `navigator.permissions.query` (the real `PermissionStatus` is returned with only its `state` mapped, so `default` → the valid `prompt`); and `window.screen`/`outerWidth` are normalized into a coherent maximized-window geometry when a `screen`/`windowSize` is set. Each patch keeps its `toString()` native and no-ops when the value was already fine (over-patching a correct value is itself a tell). `navigator.hardwareConcurrency` is set engine-level via CDP so it stays consistent inside workers; `deviceMemory` is deliberately **not** spoofed (a main-world-only override would desync from workers — a stronger tell). Add your own with `tab.addInitScript({ source })`.

Audited against `bot-detector.rebrowser.net` (no `runtimeEnableLeak`, no `navigatorWebdriver`, isolated-world execution), `bot.sannysoft.com` (0 failures), and CreepJS (0% headless, 0% stealth).

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

> **The dominant signal is your IP, not your fingerprint.** A flawless headless Chrome on an AWS egress IP still scores low on reCAPTCHA v3 and gets challenged by Cloudflare/DataDome, because datacenter ASNs are penalized *before your JavaScript runs*. Route protected targets through a **residential or mobile proxy**. The library warns on direct egress (`warnOnDirectEgress`) and `browser.checkEgress()` reports whether your exit IP is flagged as hosting.

**Lambda (`--headless=new`, no GPU):** good for soft targets only. Enable the container flags:

```ts
const browser = new Browser({
  headless: true,
  lambda: true,            // adds --no-sandbox --disable-dev-shm-usage
  spoofWebGL: true,        // coherent Linux software string
  proxy: "http://user:pass@residential-proxy:8000",
  geoCountry: "BR",        // timezone + locale + Accept-Language, matched to the proxy exit
});
```

`geoCountry` must match the proxy's exit country (a UTC clock or `pt-BR` locale on a German IP is a hard tell). If you don't know it ahead of time, set `autoGeo: true` instead of `geoCountry` and the first `newTab()` will look up the exit country **through the proxy** and set it for you (one extra request at startup; explicit `geoCountry`/`timezone`/`locale` always win, and an unmapped country warns rather than guessing).

**EC2 `g4dn`/`g5` (real NVIDIA GPU):** the posture for hard targets. Verify the GPU at `chrome://gpu`, leave `spoofWebGL` **off**, and still use a residential/mobile proxy.

## Identity & persistence

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

## WebRTC

WebRTC is left enabled (fully disabling it is itself an anomaly) but locked down to prevent IP leaks: behind a proxy it forces all UDP through the proxy (`disable_non_proxied_udp`); otherwise it exposes only the public interface and hides local IPs (`default_public_interface_only`).

## Notes & limitations

- The port mirrors the real implemented behavior in the Python package, plus the stealth and emulation additions described above.
- No JavaScript fingerprint spoofing is injected by default: in testing, native Chrome behavior is harder to detect than patched APIs. The stealth gains come from avoiding `Runtime.enable`, cleaning the headless UA/client-hints, generic world names, careful launch flags, and human-like input. Bring your own patches via `tab.addInitScript` if a target needs them.
- WebGL string spoofing is for **soft targets only** — it can't beat a forced render-hash. For hard targets, run a real GPU.
- The dominant signal is your **IP reputation**, not your fingerprint. Datacenter ASNs lose before the JavaScript runs; use a residential/mobile proxy for protected targets.

## Support

This library is built and maintained in the open. If it saved you the work of fighting `Runtime.enable` leaks, shadow-DOM traversal, and fingerprint coherence yourself, a small contribution keeps the development going:

- **[Sponsor on GitHub](https://github.com/sponsors/eurafaeldecarvalho)** — one-time or monthly
- **[Buy me a coffee on Ko-fi](https://ko-fi.com/eurafaeldecarvalho)** — quick one-off tip

Starring the repo helps too — it's how other developers find the project.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE). Free for noncommercial use; contact the author for a commercial license.
