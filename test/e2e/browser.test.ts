import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { generateExtractor, observe, type LlmRequest } from "../../src/ai/index";
import { Browser, findChrome, McpServer, scrape, ScrapeError, type Tab } from "../../src/index";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

// Real-Chrome tests. Skipped when no Chrome is installed (set CHROME_PATH to
// point at one).
const chrome = process.env.CHROME_PATH || findChrome();

describe("browser (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: FixtureServer;
  let browser: Browser;
  let tab: Tab;

  before(async () => {
    server = await startFixtureServer();
    browser = new Browser({ chromePath: chrome, headless: true, warnOnDirectEgress: false, lambda: Boolean(process.env.CI) });
    tab = await browser.newTab();
    await tab.goto({ url: `${server.origin}/article` });
    // Let the custom element upgrade and the cross-origin iframe attach.
    await tab.waitForFunction({ expression: "document.querySelector('#cross') && document.readyState === 'complete'" });
    await tab.sleep({ milliseconds: 800 });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  test("markdown includes closed shadow DOM and (opt-in) cross-origin iframes", async () => {
    const plain = await tab.markdown();
    assert.match(plain.markdown, /^# Widget 3000/);
    assert.match(plain.markdown, /### Shadow heading\n\nHidden in a closed shadow root: Secret price/);
    assert.doesNotMatch(plain.markdown, /Cross-origin frame|Copyright footer|Home/);

    const with_frames = await tab.markdown({ includeIframes: true });
    assert.match(with_frames.markdown, /#### Cross-origin frame\n\nContent from another site\./);
    assert.equal(with_frames.url, `${server.origin}/article`);
  });

  test("metadata reads JSON-LD and OpenGraph from the live DOM", async () => {
    const meta = await tab.metadata();
    assert.equal(meta.title, "Fixture Article OG");
    assert.equal(meta.canonical, `${server.origin}/article`);
    assert.deepEqual((meta.jsonLd[0] as any).offers, { price: "19.90", priceCurrency: "BRL" });
  });

  test("snapshot refs drive real elements in shadow roots and OOPIFs", async () => {
    const snap = await tab.snapshot();
    assert.doesNotMatch(snap, /InlineTextBox|ListMarker/);
    const ref = (pattern: RegExp): string => {
      const match = snap.match(pattern);
      assert.ok(match, `no match for ${pattern} in\n${snap}`);
      return match[1];
    };

    await (await tab.byRef({ ref: ref(/textbox "Email" \[ref=(e\d+)\]/) })).type({ text: "a@b.com" });
    await (await tab.byRef({ ref: ref(/button "Continue" \[ref=(e\d+)\]/) })).click();
    assert.equal(await tab.evaluate({ expression: "document.getElementById('out').textContent" }), "clicked:a@b.com");

    await (await tab.byRef({ ref: ref(/button "Shadow button" \[ref=(e\d+)\]/) })).click();
    assert.equal(await tab.title(), "shadow-clicked");

    await (await tab.byRef({ ref: ref(/button "Frame button" \[ref=(e\d+)\]/) })).click();
    await tab.sleep({ milliseconds: 300 });
    assert.match(await tab.snapshot(), /button "frame-clicked"/);

    await assert.rejects(tab.byRef({ ref: "e999" }), /Unknown ref/);

    const interactive = await tab.snapshot({ interactive: true });
    assert.ok(interactive.split("\n").every((line) => line.startsWith("- ")));
  });

  test("solveTurnstile clicks the visible widget, not its off-screen duplicate, and sees the test-key success", async () => {
    const widget_tab = await browser.newTab();
    try {
      await widget_tab.goto({ url: `${server.origin}/turnstile` });
      await widget_tab.waitForFunction({ expression: "!!document.body.dataset.frameUa" });

      // The UA override must reach the OOP iframe too (no "HeadlessChrome").
      const frame_ua = await widget_tab.evaluate({ expression: "document.body.dataset.frameUa" });
      assert.doesNotMatch(String(frame_ua), /Headless/);

      const result = await widget_tab.solveTurnstile({ timeoutMs: 20_000 });
      assert.deepEqual(result, { solved: true, token: null });
      const values = await widget_tab.evaluate({
        expression: "JSON.stringify(['w0', 'w1'].map((id) => document.querySelector('#' + id + ' input').value))",
      });
      assert.deepEqual(JSON.parse(String(values)), ["", "XXXX.DUMMY.TOKEN.XXXX"]);
    } finally {
      await browser.closeTab(widget_tab);
    }
  });

  test("scrape escalates http → browser and refuses challenge pages", async () => {
    const article = await scrape({ url: `${server.origin}/article`, browser });
    assert.equal(article.tier, "http");
    assert.equal(article.status, 200);

    const spa = await scrape({ url: `${server.origin}/spa`, browser });
    assert.equal(spa.tier, "browser");
    assert.match(spa.markdown ?? "", /# Rendered by JS/);
    assert.equal(spa.attempts[0].ok, false);

    await assert.rejects(scrape({ url: `${server.origin}/blocked`, browser, timeoutMs: 10_000 }), (error: unknown) => {
      assert.ok(error instanceof ScrapeError);
      assert.match(error.message, /http: HTTP 403/);
      return true;
    });

    const shot = await scrape({ url: `${server.origin}/products`, browser, formats: ["screenshot"] });
    assert.equal(shot.tier, "browser");
    assert.ok(shot.screenshot && shot.screenshot.length > 1_000);
  });

  test("generated extractor runs in the page without an LLM; observe() returns real elements", async () => {
    const products = await browser.newTab();
    try {
      await products.goto({ url: `${server.origin}/products` });
      const extractor = await generateExtractor({
        tab: products,
        schema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: { type: "number" } }, required: ["name", "price"] } },
        llm: async () => ({
          kind: "list",
          root: ".product",
          fields: [
            { name: "name", selector: ".name", attribute: null, type: "string", pattern: null, fields: null },
            { name: "price", selector: ".price", attribute: null, type: "number", pattern: null, fields: null },
          ],
        }),
      });
      assert.deepEqual(await extractor.run({ tab: products }), [
        { name: "Alpha", price: 10 },
        { name: "Beta", price: 25.5 },
      ]);
    } finally {
      await browser.closeTab(products);
    }

    const found = await observe({
      tab,
      instruction: "the continue button",
      llm: async (request: LlmRequest) => {
        const ref = request.prompt.match(/button "Continue" \[ref=(e\d+)\]/)?.[1];
        return { matches: ref ? [{ ref, reason: "label matches" }] : [] };
      },
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Continue");
    assert.ok(await found[0].element.isVisible());
  });

  test("MCP server over stdio: navigate, type a secret, read markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-mcp-e2e-"));
    writeFileSync(join(dir, ".env"), "EMAIL=secret.user@example.org\n");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "mcp", "--allowed-domains", "127.0.0.1,localhost", "--secrets", join(dir, ".env"), ...(chrome ? ["--chrome-path", chrome] : [])],
      { stdio: ["pipe", "pipe", "pipe"], cwd: join(__dirname, "..", "..") },
    );
    const waiters = new Map<number, (message: any) => void>();
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        waiters.get(message.id)?.(message);
      }
    });
    let id = 0;
    const call = (method: string, params: unknown = {}): Promise<any> =>
      new Promise((resolve) => {
        id += 1;
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const tool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const started = Date.now();
      const response = await call("tools/call", { name, arguments: args });
      if (process.env.DEBUG_TIMING) console.log(name, Date.now() - started);
      return response.result.content[0].text;
    };

    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      const page = await tool("navigate", { url: `${server.origin}/article` });
      assert.match(page, /<untrusted-page-content>/);
      const email = page.match(/textbox "Email" \[ref=(e\d+)\]/)?.[1];
      const button = page.match(/button "Continue" \[ref=(e\d+)\]/)?.[1];
      assert.ok(email && button);
      await tool("type", { ref: email, text: "{{EMAIL}}" });
      const after_click = await tool("click", { ref: button });
      assert.match(after_click, /clicked:\{\{EMAIL\}\}/);
      assert.doesNotMatch(after_click, /secret\.user@example\.org/);
      assert.match(await tool("markdown", { query: "price" }), /R\$ 19,90/);
      // QA round 2: a GET form puts the secret URL-encoded in the address.
      const encoded = await tool("navigate", { url: `${server.origin}/article?email=secret.user%40example.org` });
      assert.doesNotMatch(encoded, /secret\.user%40example\.org/i);
      assert.match(encoded, /email=\{\{EMAIL\}\}/);
      assert.doesNotMatch(await tool("tab_info", {}), /secret\.user%40example/i);
      assert.match(await tool("navigate", { url: "https://example.com" }), /not in the allowed list/);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.on("exit", resolve));
    }
  });
});

describe("mcp tabs (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: FixtureServer;
  let mcp: McpServer;
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const response = await mcp.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    const text = response.result.content[0].text as string;
    assert.notEqual(response.result.isError, true, text);
    return text;
  };

  before(async () => {
    server = await startFixtureServer();
    mcp = new McpServer({ browserOptions: { chromePath: chrome, headless: true, lambda: Boolean(process.env.CI) } });
  });

  after(async () => {
    await mcp?.close();
    await server?.close();
  });

  test("new_tab / list_tabs / switch_tab / close_tab, including a site-opened tab", async () => {
    assert.match(await call("navigate", { url: `${server.origin}/popup` }), /^Tab: t1\n<untrusted-page-content>\nPage: Opener/);
    assert.match(await call("new_tab", { url: `${server.origin}/products` }), /^Tab: t2\n<untrusted-page-content>\nPage: Products/);
    const two = await call("list_tabs");
    assert.match(two, /\* t2 {2}Products/);
    assert.match(two, / {2}t1 {2}Opener/);

    const back = await call("switch_tab", { id: "t1" });
    assert.match(back, /^Tab: t1\n<untrusted-page-content>\nPage: Opener/);
    assert.match(await call("snapshot"), /Opener/);

    // The page opens a tab itself (target=_blank): it must show up and be usable.
    const link = back.match(/link "Open products" \[ref=(e\d+)\]/);
    assert.ok(link, back);
    await call("click", { ref: link[1] });
    let listed = "";
    for (let attempt = 0; attempt < 20 && !/t3/.test(listed); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      listed = await call("list_tabs");
    }
    assert.match(listed, /t3 {2}Products/);
    assert.match(await call("switch_tab", { id: "t3" }), /^Tab: t3\n<untrusted-page-content>\nPage: Products/);
    assert.match(await call("markdown"), /# Products/);

    assert.match(await call("close_tab", { id: "t2" }), /Current tab unchanged/);
    assert.match(await call("close_tab"), /^Closed t3\.\n\nTab: t1/);
    const one = await call("list_tabs");
    assert.equal(one.match(/^[* ] t\d/gm)?.length, 1, one);
  });
});
