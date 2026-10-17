# Contributing

Thanks for helping! Issues, bug reports with a reproducible URL or fixture, and PRs are all welcome.

## Setup

```bash
pnpm install
pnpm run check      # typecheck
pnpm test           # unit tests (no browser)
pnpm run test:e2e   # real Chrome (set CHROME_PATH if it isn't auto-detected)
pnpm run build
```

Node 22+ is recommended for development, since the test runner uses `node --test` globs. The library itself supports Node 20+.

## Guidelines

- **Stealth first.** Don't add anything that calls `Runtime.enable`, injects into the main world by default, or adds a static, fingerprintable string. If a feature needs page JS, run it in the isolated world (`tab.evaluate`). If it can be done from a CDP tree (`DOM.getDocument`, `Accessibility.getFullAXTree`), prefer that.
- **Keep the core light.** New runtime dependencies need a strong reason. LLM-related code lives under `src/ai` and may only use the optional peers (`ai`, `zod`).
- **Tests.** Content and parsing logic gets unit tests (`test/unit`). Browser behavior gets an e2e test against `test/fixtures/server.ts`, which serves two origins so shadow-DOM and cross-origin-iframe paths are covered.
- **Changelog.** Add a line under the unreleased version in `CHANGELOG.md`.

## Releasing (maintainer)

1. Bump `version` in `package.json` and `server.json`, update `__version__` in `src/index.ts`, and date the CHANGELOG entry.
2. Commit, tag `vX.Y.Z` and push the tag. `release.yml` publishes to npm with provenance and creates the GitHub Release.
3. Publish the MCP Registry entry: `mcp-publisher publish`.
