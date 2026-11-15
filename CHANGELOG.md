# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **MCP tabs:** `new_tab`, `list_tabs`, `switch_tab`, `close_tab`. Tabs share the profile, so a login form can wait in one tab while the agent reads the e-mailed code in another. Tabs opened by the site (popups, `target=_blank`) are listed, reported as a note in the next result, and switchable. Short tab ids (`t1`, `t2`…); refs are per tab and every switch returns a fresh snapshot.
- **MCP tools for autonomous bots:** `hover`, `select_option` (native `<select>` and custom comboboxes), `set_checked`, `clear`, `fill_form`, `upload_file` (input or the button that opens the picker, via file-chooser interception), `scroll` (page or element, infinite feeds until N items / the end), `wait_for` (text, selector, ref, URL, network idle), `evaluate`, `paste` (real paste event), `handle_dialog`, `wait_for_download`, `tab_info`, `reload`, `go_forward`, `export_session` / `import_session` (cookies + localStorage to a file), `close_browser`. `press_key` takes shortcuts (`Control+A`) and an optional `ref`; `screenshot` takes `ref`/`selector` for one element; `snapshot` now starts with the tab id and title.
- MCP: JS dialog policy (`--dialogs accept|dismiss|manual`, `dialogPolicy`), downloads folder (`--downloads-dir`, `downloadsDir`). Auto-answered dialogs and finished downloads are reported as notes.
- MCP: if Chrome crashed or was closed by the user, the next call relaunches it on the same `--user-data-dir` (retrying `navigate` and read-only calls; page actions report the relaunch instead of being repeated), instead of failing with `ECONNREFUSED`. Every tool call has an upper time bound.
- Library: `browser.attachTab(targetId)`, `browser.launched` / `browser.alive` / `browser.wsEndpoint`, `profileInUse(dir)`, `tab.waitForNetworkIdle()`, `tab.cdp`, `element.callFunction()`, `element.sessionId`; `element.selectOption()` also matches by `label` and returns the chosen option; `Keyboard.press()` / `pressKey()` accept modifier combos (`parseKeyCombo`).

### Fixed
- Launching on a `userDataDir` that another Chrome already uses now throws a clear `BrowserError` instead of timing out.
- `browser.close()` asks Chrome to quit (`Browser.close`) before killing it, so cookies set just before closing persist in a reused profile (a hard kill on Windows lost them).
- Clicking/hovering an element outside the viewport scrolls it into view first; before, the input landed off screen and did nothing.
- `element.screenshot()` of an element inside an out-of-process iframe captured the wrong area.
- `browser.checkEgress()` left its lookup tab open (it only dropped the CDP connection).
- `tab.waitForNetworkIdle()` no longer waits forever on a request that never gets a response.

## [0.8.3] — 2026-10-27

### Fixed
- `scrape()` no longer reports "blocked" on a page that keeps a Turnstile widget after the stealth tier solved it (nowsecure.nl). A short page like that is returned with the reason "solved challenge still on the page (may be a gate)", because it can't be told apart from a site's own Turnstile form; Cloudflare interstitials, in any language, are still a block.
- `Browser.close()` no longer throws `ENOTEMPTY` when Chrome's helper processes are still writing into the temporary profile; it retries, then leaves the folder behind.
- `__version__` and `server.json` report the package version again (they were left at 0.8.1).

## [0.8.2] — 2026-10-27

### Changed
- README only: the detector results are summed up in one line at the top, the two install notes are merged, and the request addressed to AI assistants is gone. No code changes.

## [0.8.1] — 2026-10-17

### Fixed
- **Stealth:** out-of-process iframes (e.g. Cloudflare Turnstile's `challenges.cloudflare.com` widget) now receive the User-Agent / Client-Hints and `hardwareConcurrency` overrides. Before this, they read the real UA, which is `HeadlessChrome/…` in headless mode.
- `solveTurnstile()` works on pages with several widgets, such as responsive duplicates where one is hidden off-screen. It is now scoped to one visible, in-viewport widget, waits for an animating widget to settle before clicking (clicks used to land beside the checkbox), and checks success on that widget's own response field.
- A Turnstile test sitekey that passes (it mints `XXXX.DUMMY.TOKEN.XXXX`) is now reported as `{ solved: true, token: null }` instead of a failure. Verified 10/10 on nowsecure.nl, headless and headful.

## [0.8.0] — 2026-10-17

The "AI-ready" release: the stealth browser becomes a browser layer for LLMs and agents.

### License
- **The library is now MIT.** Versions ≤ 0.7.0 remain under PolyForm Noncommercial 1.0.0.

### Added
- `tab.markdown()`: clean, LLM-ready Markdown built from the CDP DOM tree (no page JS). It includes **closed shadow roots**, with slots composed, and optionally iframe documents, cross-origin included. Options: main-content detection, `query` relevance filter (BM25), link modes `inline` / `reference` / `none`.
- `tab.metadata()`: title, description, canonical, lang, OpenGraph, Twitter card and JSON-LD.
- `tab.snapshot()` + `tab.byRef()` + `tab.describeRef()`: accessibility outline with `[ref=eN]` on interactive elements, spanning closed shadow DOM and cross-origin iframes. Refs resolve to real `Element`s with human-like input.
- `tab.url()` and `tab.title()`.
- `browser.closeTab(tab)`: closes the page target. `tab.close()` still only disconnects.
- `scrape()`: one-call fetch that escalates `http → browser → stealth` (Turnstile), reports the tier and every attempt, and throws `ScrapeError` instead of returning a challenge page. `detectBlock()` is exported.
- `htmlToMarkdown()` and `extractMetadata()` for HTML you already have (no browser).
- **CLI** (`browser-scraper` bin): `scrape`, `markdown`, `snapshot`, `mcp`.
- **MCP server** (`McpServer`, `browser-scraper mcp`), dependency-free stdio JSON-RPC. Tools: navigate, snapshot, click, type, press_key, go_back, wait, markdown, metadata, screenshot, solve_turnstile, scrape, check_egress. Guard rails: `--allowed-domains`, `--secrets` (`{{NAME}}` placeholders, redacted from output), and untrusted-content fencing.
- `server.json` for the MCP Registry, plus an Agent Skill in `skills/browser-scraper/SKILL.md`.
- **`/ai` subpath** (optional peer deps `ai`, `zod`):
  - `extract()`: schema-driven extraction with a Vercel AI SDK model or your own `llm` function. Input can be Markdown, the snapshot, or a screenshot for vision models.
  - `generateExtractor()` → `Extractor`: the LLM writes CSS selectors once, `run()` extracts with no LLM, `runOrHeal()` regenerates selectors when validation fails and falls back to `extract()`. Plans can be saved and loaded as JSON.
  - `observe()`: locates elements by natural-language instruction and returns real `Element`s. There is no autonomous agent loop.
- Test suite (`node:test`): unit tests, plus e2e tests against real Chrome with a two-origin fixture server for closed shadow DOM and OOPIF coverage. CI on GitHub Actions, and a release workflow with npm Trusted Publishing + provenance.

### Changed
- `better-sqlite3` is now an **optional** dependency, loaded lazily. Profile history seeding falls back to Node's built-in `node:sqlite` (≥ 22.5). Installing no longer fails where the native build breaks (e.g. Node 24 on Windows).
- `package.json`: new description and keywords. Vendor names were removed from the keywords. Added `bin`, `exports["./ai"]` and `mcpName`.

### Fixed
- `waitForNavigation()` (and so `goto()`) left a 30 s timer running after the navigation finished, which kept short scripts and CLIs alive for ~30 s after `browser.close()`.
- On Windows, `browser.close()` now kills Chrome's whole process tree. Helpers were left running and kept the stderr pipe open.
- Interacting with an element inside an out-of-process iframe used the offset of the *first* iframe on the page instead of the one hosting the element.

## [0.7.0] — 2026-06-18

- Browserless HTTP fast lane (`HttpClient`, `browser.createHttpClient()`), with curl-impersonate support.
- WebGL OS/renderer mismatch guard, worker-coherent `hardwareConcurrency`, main-world `evaluate`, `solveTurnstile()`, randomized isolated-world name, and resuming of workers and popups.

## [0.6.0] — 2026-06-15

- Stealth and User-Agent management improvements.

[0.8.1]: https://github.com/eurafaeldecarvalho/browser-scraper/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/eurafaeldecarvalho/browser-scraper/compare/95268f9...v0.8.0
[0.7.0]: https://github.com/eurafaeldecarvalho/browser-scraper/commits/95268f9
