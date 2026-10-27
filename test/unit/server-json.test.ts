import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Official MCP Registry returns HTTP 422 when server.json `description` exceeds 100 characters.
const MCP_REGISTRY_DESCRIPTION_MAX = 100;

const PUBLIC_COPY = [
  "README.md",
  "package.json",
  "server.json",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "src/cli.ts",
  "skills/browser-scraper/SKILL.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/antibot-and-captcha-research.md",
];

test("server.json description fits the MCP Registry limit", () => {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as { description: string };
  assert.equal(typeof server.description, "string");
  assert.ok(server.description.length > 0);
  assert.ok(
    server.description.length <= MCP_REGISTRY_DESCRIPTION_MAX,
    `server.json description is ${server.description.length} characters; the MCP Registry allows at most ${MCP_REGISTRY_DESCRIPTION_MAX}`,
  );
  assert.doesNotMatch(server.description, /undetect/i);
});

test("public copy does not describe the browser as undetected", () => {
  for (const file of PUBLIC_COPY) {
    const text = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(text, /undetect/i, `${file} still uses undetected/undetectable wording`);
  }
});
