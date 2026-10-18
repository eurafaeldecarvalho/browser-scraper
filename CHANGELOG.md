# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.8.0] — unreleased

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

[0.8.0]: https://github.com/eurafaeldecarvalho/browser-scraper/compare/95268f9...HEAD
[0.7.0]: https://github.com/eurafaeldecarvalho/browser-scraper/commits/95268f9
