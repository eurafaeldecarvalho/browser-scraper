import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { findChrome } from "../../src/index";

// Regressions found by black-box QA of the MCP server (a bot driving it over
// stdio on realistic pages): each test is one defect that round fixed.
const chrome = process.env.CHROME_PATH || findChrome();

const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/popup": page("Opener", `<button onclick="window.open('/account','acct','width=400,height=400')">Continue with Google</button><p id="st">not signed</p><script>addEventListener('message',e=>{st.textContent='signed as '+e.data})</script>`),
  "/account": page("Choose account", `<button onclick="opener.postMessage('qa@example.com','*');window.close()">qa@example.com</button>`),
  "/form": page("Form", `<form onsubmit="event.preventDefault();o.textContent='sent:'+new URLSearchParams(new FormData(this))"><label>Name <input name="name"></label><label>Size <select name="size"><option>S</option><option>M</option></select></label><label><input type="checkbox" name="news" value="y"> News</label></form><p id="o"></p>`),
  "/slider": page("Slider", `<input type="range" id="s" min="0" max="100" value="0" style="width:300px;margin:0;display:block" aria-label="Volume">`),
  "/api": page("Api", `<p>api</p><script>fetch('/data.json')</script>`),
  "/hang": page("Hanging", `<p>still usable</p><img src="/never">`),
  "/plain": page("Plain", `<p>nothing to solve</p>`),
};

describe("mcp QA regressions (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: http.Server;
  let origin: string;
  let child: ChildProcessWithoutNullStreams;
  let profile: string;
  const waiters = new Map<number, (message: any) => void>();
  let next_id = 0;
  const call = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve) => {
      next_id += 1;
      waiters.set(next_id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next_id, method, params })}\n`);
    });
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; ms: number }> => {
    const started = Date.now();
    const response = await call("tools/call", { name, arguments: args });
    const text = response.result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    return { text, isError: Boolean(response.result.isError), ms: Date.now() - started };
  };
  const ref = (text: string, pattern: RegExp): string => {
    const line = text.split("\n").find((each) => pattern.test(each) && /\[ref=e\d+\]/.test(each));
    assert.ok(line, `no ${pattern} in\n${text}`);
    return /\[ref=(e\d+)\]/.exec(line)![1];
  };

  before(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/never") {
        return; // never answers: the page's load event never fires
      }
      if (path === "/data.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"items":[1,2]}');
        return;
      }
      res.writeHead(PAGES[path] ? 200 : 404, { "content-type": "text/html" });
      res.end(PAGES[path] ?? "nf");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    profile = mkdtempSync(join(tmpdir(), "bs-qa-profile-"));
    child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp", "--user-data-dir", profile, ...(chrome ? ["--chrome-path", chrome] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
    });
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
    child.stderr.on("data", () => undefined);
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } });
  });

  after(async () => {
    child?.stdin.end();
    await new Promise((resolve) => child?.on("exit", resolve));
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  test("a popup that closes itself during click falls back to another tab instead of erroring", async () => {
    let out = await tool("navigate", { url: `${origin}/popup` });
    out = await tool("click", { ref: ref(out.text, /Continue with Google/) });
    const popup = /new tab (t\d+)/.exec(out.text)?.[1];
    assert.ok(popup, out.text);
    out = await tool("switch_tab", { id: popup });
    out = await tool("click", { ref: ref(out.text, /qa@example\.com/) });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, new RegExp(`Tab ${popup} closed itself`));
    assert.match(out.text, /signed as qa@example\.com/);
    out = await tool("snapshot");
    assert.equal(out.isError, false, out.text);
  });

  test("fill_form presses Enter in the text field even after filling a select and a checkbox", async () => {
    let out = await tool("navigate", { url: `${origin}/form` });
    out = await tool("fill_form", {
      fields: [
        { ref: ref(out.text, /textbox "Name"/), value: "Rafa" },
        { ref: ref(out.text, /combobox "Size"/), value: "M" },
        { ref: ref(out.text, /checkbox "News"/), value: true },
      ],
      submit: true,
    });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /sent:name=Rafa&size=M&news=y/);
  });

  test("drag moves a native range slider (moves carry the held button)", async () => {
    await tool("navigate", { url: `${origin}/slider` });
    const box = JSON.parse((await tool("evaluate", { expression: "(()=>{const r=document.getElementById('s').getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,w:r.width}})()" })).text.replace(/<\/?untrusted-page-content>/g, ""));
    const out = await tool("drag", { fromX: box.x + 5, fromY: box.y, toX: box.x + box.w - 2, toY: box.y });
    assert.equal(out.isError, false, out.text);
    const value = Number(JSON.parse((await tool("evaluate", { expression: "document.getElementById('s').value" })).text.replace(/<\/?untrusted-page-content>/g, "")));
    assert.ok(value > 85, `slider value ${value}`);
  });

  test("evaluate reports the thrown message, fenced as page content", async () => {
    const out = await tool("evaluate", { expression: "(()=>{throw new Error('boom 42')})()" });
    assert.equal(out.isError, true);
    assert.match(out.text, /<untrusted-page-content>\s*Error: boom 42/);
  });

  test("response_body right after navigate waits for the body instead of 'still loading'", async () => {
    await tool("navigate", { url: `${origin}/api` });
    const list = await tool("network_requests", { urlIncludes: "data.json" });
    const id = /\b(r\d+)\b/.exec(list.text)?.[1];
    assert.ok(id, list.text);
    const out = await tool("response_body", { id });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /"items"/);
  });

  test("navigate returns a page whose load never fires (hanging image) with a note, well before 45 s", async () => {
    const out = await tool("navigate", { url: `${origin}/hang` });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /still usable/);
    assert.match(out.text, /did not reach "load"/);
    assert.ok(out.ms < 30_000, `${out.ms} ms`);
  });

  test("solve_turnstile on a page without a widget answers in seconds", async () => {
    await tool("navigate", { url: `${origin}/plain` });
    const out = await tool("solve_turnstile");
    assert.match(out.text, /no Cloudflare Turnstile widget/);
    assert.ok(out.ms < 12_000, `${out.ms} ms`);
  });

  test("wait honors the requested time and says when it was capped", async () => {
    let out = await tool("wait", { seconds: 1 });
    assert.ok(out.ms >= 950 && out.ms < 2_500, `${out.ms} ms`);
    out = await tool("wait", { seconds: 31 });
    assert.match(out.text, /Waited 30 s \(the maximum/);
    assert.ok(out.ms < 33_000, `${out.ms} ms`);
  });
});
