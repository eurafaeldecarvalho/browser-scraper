import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { findChrome } from "../../src/index";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

// The bot-oriented tools added after the review loop, driven like a real
// client: a child MCP server over stdio on a persistent profile.
const chrome = process.env.CHROME_PATH || findChrome();

type Result = { text: string; isError: boolean; raw: any };
type Client = { tool: (name: string, args?: Record<string, unknown>) => Promise<Result>; stop: () => Promise<void> };

async function start_client(args: string[]): Promise<Client> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp", ...args, ...(chrome ? ["--chrome-path", chrome] : [])], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: join(__dirname, "..", ".."),
  });
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
  child.stderr.on("data", (chunk) => process.env.DEBUG_MCP && process.stderr.write(chunk));
  let id = 0;
  const call = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve) => {
      id += 1;
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  return {
    tool: async (name, toolArgs = {}) => {
      const response = await call("tools/call", { name, arguments: toolArgs });
      const part = response.result.content[0];
      return { text: part.type === "text" ? part.text : "", isError: Boolean(response.result.isError), raw: response.result };
    },
    stop: async () => {
      child.stdin.end();
      await new Promise((resolve) => child.on("exit", resolve));
    },
  };
}

const json = (text: string): any => JSON.parse(text.replace(/<\/?untrusted-page-content>/g, "").trim());

const ref = (snapshot: string, pattern: RegExp): string => {
  const match = snapshot.match(pattern);
  assert.ok(match, `no ${pattern} in\n${snapshot.slice(0, 3000)}`);
  return match[1];
};

describe("mcp agent tools over stdio (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: FixtureServer;
  let client: Client;
  let profile: string;
  let work: string;

  before(async () => {
    server = await startFixtureServer();
    profile = mkdtempSync(join(tmpdir(), "bs-tools-profile-"));
    work = mkdtempSync(join(tmpdir(), "bs-tools-work-"));
    client = await start_client(["--user-data-dir", profile, "--downloads-dir", join(work, "downloads"), "--snapshot-mode", "diff", ...(process.env.E2E_HEADFUL ? ["--headful"] : [])]);
  });

  after(async () => {
    await client?.stop();
    await server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  test("find, stable refs and diff snapshots", async () => {
    const { tool } = client;
    const page = (await tool("navigate", { url: `${server.origin}/tools` })).text;
    // First page state of a tab is the full snapshot (no base yet).
    assert.match(page, /button "Needle button"/);
    const full_size = page.length;

    let out: Result;
    const found = await tool("find", { text: "needle" });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /1 match\(es\)/);
    assert.match(found.text, /→ \s*- button "Needle button" \[ref=e\d+\]/);
    assert.ok(found.text.length < 1_000, `find output too big: ${found.text.length}`);
    const needle = ref(found.text, /button "Needle button" \[ref=(e\d+)\]/);
    assert.equal(ref(page, /button "Needle button" \[ref=(e\d+)\]/), needle, "refs are stable across snapshots");

    const roles = await tool("find", { role: "button", text: "/^.*Edit 19\\d.*$/", limit: 5 });
    assert.match(roles.text, /10 match\(es\), first 5 shown/);

    const none = await tool("find", { text: "no such thing anywhere" });
    assert.match(none.text, /No element matches/);

    // An action in diff mode returns only what changed.
    const clicked = await tool("click", { ref: ref(page, /button "Double me" \[ref=(e\d+)\]/), doubleClick: true });
    assert.match(clicked.text, /Changes since the last snapshot: \+\d+ \/ -\d+/);
    assert.match(clicked.text, /\+ .*double clicked/);
    assert.ok(clicked.text.length < full_size / 5, `diff not smaller: ${clicked.text.length} vs ${full_size}`);

    const same = await tool("snapshot", { diff: true });
    assert.match(same.text, /no changes since the last snapshot/);
    // find shows only matches: it must not become the diff base, or a change
    // made before it would never reach the agent.
    await tool("evaluate", { expression: "document.body.insertAdjacentHTML('afterbegin', '<h2>Injected heading</h2>')", world: "main" });
    assert.match((await tool("find", { text: "needle" })).text, /Needle button/);
    assert.match((await tool("snapshot", { diff: true })).text, /\+ .*Injected heading/);
    const full = await tool("snapshot");
    assert.match(full.text, /button "Needle button" \[ref=e\d+\]/);

    // A navigation starts a new document: the diff base must be dropped, or an
    // identical page reads as "no changes" while every old ref is gone.
    await tool("navigate", { url: `${server.origin}/products` });
    out = await tool("navigate", { url: `${server.origin}/products` });
    assert.match(out.text, /heading "Products"/);
    assert.doesNotMatch(out.text, /no changes since the last snapshot/);
  });

  test("right click, click_at, drag (pointer slider and HTML5 dnd), contenteditable typing", async () => {
    const { tool } = client;
    let page = (await tool("navigate", { url: `${server.origin}/tools` })).text;
    let out = await tool("click", { ref: ref(page, /button "Right me" \[ref=(e\d+)\]/), button: "right" });
    assert.match(out.text, /context menu/);

    const box = json((await tool("element_info", { selector: "#dbl" })).text).box;
    out = await tool("click_at", { x: box.x + box.width / 2, y: box.y + box.height / 2, doubleClick: true });
    assert.match(out.text, /Clicked at/);
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('out').textContent" })).text), "double clicked");
    out = await tool("click_at", { x: 99_999, y: 5 });
    assert.equal(out.isError, true);
    assert.match(out.text, /outside the viewport/);

    const track = json((await tool("element_info", { selector: "#track" })).text).box;
    out = await tool("drag", { selector: "#knob", toX: track.x + 200, toY: track.y + 15 });
    assert.equal(out.isError, false, out.text);
    const slid = Number(String(json((await tool("evaluate", { expression: "document.getElementById('slid').textContent" })).text)).split(":")[1]);
    assert.ok(slid > 120 && slid <= 270, `slider moved ${slid}`);

    // A point refers to the viewport as it is: an off-screen element end must
    // not be scrolled into view (the point would then hit something else).
    await tool("evaluate", { expression: "scrollTo(0, 3000)" });
    out = await tool("drag", { selector: "#knob", toX: 10, toY: 10 });
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /not visible in the viewport/);
    assert.equal(json((await tool("evaluate", { expression: "scrollY > 1000" })).text), true, "drag must not scroll when a point is given");
    await tool("evaluate", { expression: "scrollTo(0, 0)" });

    out = await tool("drag", { selector: "#card", toSelector: "#lane" });
    assert.equal(out.isError, false, out.text);
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('dnd').textContent" })).text), "dropped:card-1");

    page = (await tool("snapshot")).text;
    out = await tool("type", { ref: ref(page, /textbox "What is happening" \[ref=(e\d+)\]/), text: "Hello from the bot #launch" });
    assert.equal(out.isError, false, out.text);
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('composer').innerText.trim()" })).text), "Hello from the bot #launch");

    const info = json((await tool("element_info", { ref: ref(page, /link "Products link" \[ref=(e\d+)\]/) })).text);
    // SVG <a>: href is an SVGAnimatedString, not "[object SVGAnimatedString]".
    assert.match(json((await tool("element_info", { selector: "#svglink" })).text).href, /\/svg-target$/);
    assert.equal(info.tag, "a");
    assert.equal(info.attributes["data-id"], "42");
    assert.match(info.href, /\/products$/);
    assert.equal(info.role, "link");
  });

  test("drop_files (real drag of files) and paste of an image", async () => {
    const { tool } = client;
    await tool("navigate", { url: `${server.origin}/tools` });
    const image = join(work, "photo.png");
    writeFileSync(image, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const video = join(work, "clip.mp4");
    writeFileSync(video, Buffer.alloc(2048, 1));
    let out = await tool("drop_files", { selector: "#dropzone", paths: [image, video] });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /Dropped photo\.png, clip\.mp4 \(browser drag-and-drop\)/);
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('dz').textContent" })).text), "files:photo.png:16:image/png,clip.mp4:2048:video/mp4:trusted=true");

    out = await tool("drop_files", { selector: "#pastebox", paths: [image], mode: "paste" });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /handled by the page/);
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('pz').textContent" })).text), "pasted:photo.png:16");

    out = await tool("drop_files", { selector: "#dropzone", paths: ["relative.png"] });
    assert.equal(out.isError, true);
    assert.match(out.text, /absolute/);
  });

  test("network log, response bodies and wait_for_response", async () => {
    const { tool } = client;
    const page = (await tool("navigate", { url: `${server.origin}/tools` })).text;
    let out = await tool("network_requests", {});
    assert.match(out.text, /GET 200 Document text\/html .*\/tools/);
    await tool("click", { ref: ref(page, /button "Load data" \[ref=(e\d+)\]/) });
    out = await tool("wait_for_response", { urlIncludes: "/api/data", timeout: 10 });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /POST 200 Fetch application\/json/);
    assert.match(out.text, /"name": "alpha"/);
    // Each response is returned once.
    out = await tool("wait_for_response", { urlIncludes: "/api/data", timeout: 1 });
    assert.equal(out.isError, true);
    assert.match(out.text, /Timeout/);

    out = await tool("network_requests", { urlIncludes: "/api/data", method: "POST" });
    const id = ref(out.text, /(r\d+) t\d+ POST 200/);
    out = await tool("response_body", { id });
    assert.match(out.text, /"method": "POST"/);
    out = await tool("response_body", { id: "r999999" });
    assert.equal(out.isError, true);
    // Size cap uses the decoded size: a gzip bomb is tiny on the wire.
    await tool("evaluate", { expression: "fetch('/api/bomb').then((r) => r.text()).then((t) => t.length)", world: "main" });
    out = await tool("network_requests", { urlIncludes: "/api/bomb" });
    out = await tool("response_body", { id: ref(out.text, /(r\d+) t\d+ GET 200/) });
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /response_body reads at most/);
  });

  test("cookies, emulate, save_pdf, browser_status, batch", async () => {
    const { tool } = client;
    const page = (await tool("navigate", { url: `${server.origin}/tools` })).text;
    let out = await tool("cookies", { action: "set", name: "sid", value: "abc123" });
    assert.match(out.text, /Cookie sid set/);
    out = await tool("cookies", {});
    assert.match(out.text, /sid=abc123\s+domain=127\.0\.0\.1/);
    out = await tool("cookies", { action: "delete", name: "sid" });
    out = await tool("cookies", { name: "sid" });
    assert.match(out.text, /No cookies named sid/);

    out = await tool("emulate", { latitude: -23.55, longitude: -46.63, timezone: "America/Sao_Paulo", locale: "pt-BR" });
    assert.equal(out.isError, false, out.text);
    const probe = json(
      (await tool("evaluate", { expression: "new Promise((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.latitude, p.coords.longitude, Intl.DateTimeFormat().resolvedOptions().timeZone]), (e) => resolve(['error', e.message])))", world: "main" })).text,
    );
    assert.deepEqual(probe, [-23.55, -46.63, "America/Sao_Paulo"]);
    out = await tool("emulate", { timezone: "Not/AZone" });
    assert.equal(out.isError, true);
    await tool("emulate", { reset: true });
    // reset must not leave geolocation granted (sites would get the real location)
    // nor the emulated locale in navigator.languages.
    const languages = async (): Promise<any> => json((await tool("evaluate", { expression: "navigator.permissions.query({ name: 'geolocation' }).then((p) => [p.state, navigator.languages.join(',')])", world: "main" })).text);
    assert.notEqual((await languages())[0], "granted");
    await tool("emulate", { locale: "de-DE" });
    assert.match((await languages())[1], /de-DE/);
    await tool("emulate", { reset: true });
    assert.doesNotMatch((await languages())[1], /de-DE/);
    // Emulation is session-wide: tabs opened before the call follow it, and reset.
    const zone = "Intl.DateTimeFormat().resolvedOptions().timeZone";
    const first_tab = ref((await tool("snapshot")).text, /Tab: (t\d+)/);
    const second_tab = ref((await tool("new_tab", { url: `${server.origin}/tools` })).text, /Tab: (t\d+)/);
    await tool("switch_tab", { id: first_tab });
    await tool("emulate", { timezone: "Asia/Tokyo" });
    await tool("switch_tab", { id: second_tab });
    assert.match((await tool("evaluate", { expression: zone, world: "main" })).text, /Asia\/Tokyo/);
    await tool("emulate", { reset: true });
    await tool("switch_tab", { id: first_tab });
    assert.doesNotMatch((await tool("evaluate", { expression: zone, world: "main" })).text, /Asia\/Tokyo/);
    await tool("switch_tab", { id: second_tab });
    await tool("close_tab", {});
    await tool("switch_tab", { id: first_tab });

    out = await tool("save_pdf", { path: "\\\\127.0.0.1\\share\\x.pdf" });
    assert.equal(out.isError, true);
    assert.match(out.text, /Network\/device paths are not allowed/);
    out = await tool("drop_files", { selector: "body", paths: ["//127.0.0.1/share/a.png"] });
    assert.match(out.text, /Network\/device paths are not allowed/);

    out = await tool("save_pdf", {});
    assert.equal(out.isError, false, out.text);
    const pdf = /Path: (.+\.pdf)/.exec(out.text)?.[1] ?? "";
    // The title-derived name is page-controlled: it stays inside the markers.
    assert.match(out.text, /<untrusted-page-content>[^]*Path: [^]*\.pdf/);
    assert.ok(existsSync(pdf), out.text);
    assert.equal(readFileSync(pdf).subarray(0, 4).toString(), "%PDF");

    out = await tool("browser_status", {});
    assert.match(out.text, /Browser: running/);
    assert.match(out.text, /Snapshot mode: diff/);
    assert.match(out.text, /JS heap: /);
    // A frozen page must not hang the health check.
    void tool("evaluate", { expression: "setTimeout(() => { const end = Date.now() + 6000; while (Date.now() < end); }, 50); 1", world: "main" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const started = Date.now();
    out = await tool("browser_status", {});
    assert.match(out.text, /Browser: running/);
    assert.ok(Date.now() - started < 5_000, `browser_status took ${Date.now() - started} ms on a busy page`);
    await new Promise((resolve) => setTimeout(resolve, 6000));

    out = await tool("batch", {
      steps: [
        { tool: "type", args: { ref: ref(page, /textbox "What is happening" \[ref=(e\d+)\]/), text: "batched" } },
        { tool: "click", args: { ref: ref(page, /button "Right me" \[ref=(e\d+)\]/), button: "right" } },
        { tool: "find", args: { text: "context menu" } },
      ],
    });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /^1\. type: ok\n2\. click: ok\n3\. find: ok/);
    assert.match(out.text, /→ .*context menu/);

    out = await tool("batch", { steps: [{ tool: "click", args: { ref: "e999999" } }, { tool: "snapshot" }] });
    assert.equal(out.isError, true);
    assert.match(out.text, /1\. click: ERROR .*Unknown ref[\s\S]*Stopped at step 1/);
    // A step that returns isError (not a throw) also stops the batch.
    out = await tool("batch", { steps: [{ tool: "emulate", args: { timezone: "Not/AZone" } }, { tool: "snapshot" }] });
    assert.equal(out.isError, true);
    assert.match(out.text, /Stopped at step 1/);
    out = await tool("batch", { steps: [{ tool: "batch", args: {} }] });
    assert.match(out.text, /cannot be nested/);

    // Screenshots from earlier steps are bounded: 5 of them would be one
    // response of several MB.
    out = await tool("batch", {
      steps: [
        { tool: "screenshot" },
        { tool: "screenshot" },
        { tool: "screenshot" },
        { tool: "screenshot" },
        { tool: "screenshot" },
        { tool: "snapshot" },
      ],
    });
    assert.equal(out.raw.content.filter((part: any) => part.type === "image").length, 3, out.text);
    assert.match(out.text, /earlier steps' images dropped/);

    // A batch whose browser dies mid-way must say which steps already ran:
    // repeating them would submit them twice.
    out = await tool("batch", {
      steps: [{ tool: "navigate", args: { url: `${server.origin}/tools` } }, { tool: "close_browser" }, { tool: "snapshot" }],
    });
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /step 3/);
    assert.match(out.text, /1\. navigate: ok/);
    assert.match(out.text, /2\. close_browser: ok/);
  });

  test("solve_captcha: checkbox click, and image challenge returned for vision", async () => {
    const { tool } = client;
    await tool("navigate", { url: `${server.origin}/captcha` });
    let out = await tool("solve_captcha", { checkOnly: true });
    assert.match(out.text, /reCAPTCHA: not solved yet/);
    out = await tool("solve_captcha", {});
    assert.match(out.text, /reCAPTCHA: solved \(token present\)/);

    await tool("navigate", { url: `${server.origin}/captcha?challenge=1` });
    out = await tool("solve_captcha", {});
    assert.match(out.text, /image challenge is open at viewport box x=\d+ y=\d+ width=400 height=300/);
    const image = out.raw.content.find((part: any) => part.type === "image");
    assert.ok(image && image.data.length > 100, "challenge screenshot attached");

    await tool("navigate", { url: `${server.origin}/tools` });
    out = await tool("solve_captcha", {});
    assert.match(out.text, /No reCAPTCHA\/hCaptcha checkbox/);
  });
});
