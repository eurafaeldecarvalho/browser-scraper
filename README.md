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

The library is built to minimize the signals anti-bot vendors (Cloudflare, DataDome, Kasada) look for:

- **No `Runtime.enable`.** That CDP call is the single most widely used automation tell. All JavaScript runs through `Page.createIsolatedWorld` + `Runtime.evaluate`, which are plain commands that do not enable the Runtime domain. Context invalidation is handled via `Page.frameNavigated` and stale-context retries.
- **Clean User-Agent + client hints.** In `--headless=new`, Chrome injects `HeadlessChrome` into the UA and `sec-ch-ua`. The library strips it and applies matching `userAgentMetadata` so `navigator.userAgentData` stays consistent.
- **Generic isolated-world names** (`util`) instead of identifiable ones.
- **Launch flags** avoid options whose mere presence is a fingerprint (`--disable-popup-blocking`, `--disable-component-update`, `--disable-extensions`, `--enable-automation`).
- **Human-like input.** Clicks move the cursor along a Bézier path with variable speed; typing dispatches real `keyDown`/`keyUp` events with proper `keyCode`/`code`.

`navigator.webdriver` is hidden via `--disable-blink-features=AutomationControlled`. Deliberately, no default JavaScript fingerprint patches are injected — native Chrome behavior is harder to detect than a patched API. Use `tab.addInitScript({ source })` if you want to add your own.

Audited against `bot-detector.rebrowser.net` (no `runtimeEnableLeak`, no `navigatorWebdriver`, isolated-world execution), `bot.sannysoft.com` (0 failures), and CreepJS (0% headless, 0% stealth).

### WebGL / GPU on cloud hosts

On your machine WebGL reports your real GPU. On a **GPU-less cloud server, Chrome falls back to SwiftShader/llvmpipe**, and `Software Rasterizer` / `SwiftShader` in the WebGL renderer is a strong, widely-used headless signal. Spoof a believable GPU there:

```ts
// Easiest: a believable default GPU
const browser = new Browser({ spoofWebGL: true });

// Or pick the exact strings
const browser = new Browser({
  webglVendor: "Google Inc. (NVIDIA)",
  webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
});

// Or per-tab, before navigating
await tab.spoofWebGL({ vendor: "...", renderer: "..." });
```

The override runs in the page's main world (where detection scripts read WebGL) and keeps `getParameter.toString()` native-looking so the patch itself isn't flagged. Leave it **off locally** (a real GPU is best). Known limitation: the override targets the main thread, not Web Workers/OffscreenCanvas — a determined detector can still read the unspoofed value from a worker.

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
  proxy: null,
  extraArgs: [],
  autoSeed: true,
});
```

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

## Notes

- The port mirrors the real implemented behavior in the Python package, plus the stealth and emulation additions described above.
- No JavaScript fingerprint spoofing is injected by default: in testing, native Chrome behavior is harder to detect than patched APIs. The stealth gains come from avoiding `Runtime.enable`, cleaning the headless UA/client-hints, generic world names, careful launch flags, and human-like input. Bring your own patches via `tab.addInitScript` if a target needs them.

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