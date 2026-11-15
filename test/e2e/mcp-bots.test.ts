import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Browser, BrowserError, findChrome, profileInUse } from "../../src/index";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";

// Drives the MCP server as a real client would: a child process over stdio,
// a persistent --user-data-dir, and every bot-oriented tool once.
const chrome = process.env.CHROME_PATH || findChrome();

type Client = { child: ChildProcessWithoutNullStreams; tool: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; raw: any }>; stop: () => Promise<void> };

async function start_client(args: string[]): Promise<Client> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp", ...args, ...(chrome ? ["--chrome-path", chrome] : [])], {
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
    child,
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
  assert.ok(match, `no ${pattern} in\n${snapshot}`);
  return match[1];
};

describe("mcp bot tools over stdio (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: FixtureServer;
  let client: Client;
  let profile: string;
  let work: string;

  before(async () => {
    server = await startFixtureServer();
    profile = mkdtempSync(join(tmpdir(), "bs-bots-profile-"));
    work = mkdtempSync(join(tmpdir(), "bs-bots-work-"));
    client = await start_client(["--user-data-dir", profile, "--dialogs", "manual", "--downloads-dir", join(work, "downloads")]);
  });

  after(async () => {
    await client?.stop();
    await server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  test("every new tool on a real page", async () => {
    const { tool } = client;
    let page = (await tool("navigate", { url: `${server.origin}/bots` })).text;
    assert.match(page, /^Tab: t1/);

    // select_option: native <select> by label, custom combobox by option text.
    let out = await tool("select_option", { ref: ref(page, /combobox "Country"[^\n]*\[ref=(e\d+)\]/), label: "Portugal" });
    assert.match(out.text, /Selected: Portugal \(value pt\)/);
    out = await tool("select_option", { ref: ref(out.text, /combobox: "Pick a color" \[ref=(e\d+)\]/), label: "Blue" });
    assert.match(out.text, /Color: Blue/);

    // upload_file through the visible button of a hidden input.
    const cv = join(work, "cv.pdf");
    writeFileSync(cv, "%PDF-1.4 fake cv");
    out = await tool("upload_file", { ref: ref(out.text, /button "Upload CV" \[ref=(e\d+)\]/), paths: [cv] });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /file:cv\.pdf:16/);

    // hover
    out = await tool("hover", { selector: "#hov" });
    assert.match(out.text, /Hover menu open/);

    // set_checked / fill_form (text + checkbox + radio) / clear
    page = out.text;
    out = await tool("set_checked", { ref: ref(page, /checkbox "Accept terms"[^\n]*\[ref=(e\d+)\]/), checked: true });
    assert.match(out.text, /checked: true/);
    page = out.text;
    out = await tool("fill_form", {
      fields: [
        { ref: ref(page, /textbox "City" \[ref=(e\d+)\]/), value: "Lisboa" },
        { ref: ref(page, /radio "Plan B"[^\n]*\[ref=(e\d+)\]/), value: true },
        { ref: ref(page, /checkbox "Accept terms"[^\n]*\[ref=(e\d+)\]/), value: false },
      ],
    });
    assert.equal(out.isError, false, out.text);
    assert.deepEqual(json((await tool("evaluate", { expression: "[document.querySelector('input[value=b]').checked, document.getElementById('terms').checked]" })).text), [true, false]);
    out = await tool("clear", { ref: ref(out.text, /textbox "Name"[^\n]*\[ref=(e\d+)\]/) });
    const values = json((await tool("evaluate", { expression: "({ name: document.getElementById('name').value, city: document.getElementById('city').value })" })).text);
    assert.deepEqual(values, { name: "", city: "Lisboa" });

    // evaluate in both worlds
    out = await tool("evaluate", { expression: "({ items: document.querySelectorAll('.item').length, title: document.title })" });
    assert.match(out.text, /"items": 10/);
    out = await tool("evaluate", { expression: "typeof more", world: "main" });
    assert.match(out.text, /"function"/);

    // paste (fires a real paste event) + keyboard shortcut
    page = (await tool("snapshot")).text;
    out = await tool("paste", { ref: ref(page, /textbox "OTP" \[ref=(e\d+)\]/), text: "482913" });
    assert.match(out.text, /pasted:482913/);
    const notes = ref(out.text, /textbox "Notes" \[ref=(e\d+)\]/);
    await tool("type", { ref: notes, text: "hello world" });
    await tool("press_key", { ref: notes, key: "Control+A" });
    await tool("press_key", { ref: notes, key: "Backspace" });
    assert.equal(json((await tool("evaluate", { expression: "document.getElementById('notes').value" })).text), "");

    // scroll: element feed until N items, then page down
    out = await tool("scroll", { container: "#feed", selector: ".item", untilCount: 30, snapshot: false });
    assert.match(out.text, /reached 30 items/);
    out = await tool("scroll", { container: "#feed", untilEnd: true, selector: ".item", snapshot: false });
    assert.match(out.text, /reached the end/);
    assert.match(out.text, /Items: 50/);
    out = await tool("scroll", { direction: "down", amount: 600, snapshot: false });
    assert.match(out.text, /Position [1-9]\d*\/\d+ px/);

    // wait_for: text appears, URL changes, network idle, clear timeout error
    page = (await tool("snapshot")).text;
    await tool("click", { ref: ref(page, /button "Show later" \[ref=(e\d+)\]/) });
    out = await tool("wait_for", { text: "Ready later!", timeout: 10 });
    assert.match(out.text, /Condition met/);
    await tool("click", { ref: ref(out.text, /button "Go step 2" \[ref=(e\d+)\]/) });
    assert.match((await tool("wait_for", { urlIncludes: "#step2", networkIdle: true, timeout: 10 })).text, /Condition met/);
    out = await tool("wait_for", { text: "never shows up", timeout: 1 });
    assert.equal(out.isError, true);
    assert.match(out.text, /Timeout after 1s waiting for: text "never shows up"/);

    // dialogs (manual policy): the click returns, other tools refuse, handle_dialog answers.
    page = (await tool("snapshot")).text;
    out = await tool("click", { ref: ref(page, /button "Ask confirm" \[ref=(e\d+)\]/) });
    assert.match(out.text, /A confirm dialog is open/);
    assert.match((await tool("snapshot")).text, /A confirm dialog is open on this tab/);
    assert.match((await tool("tab_info")).text, /Dialog: confirm "Delete everything\?"/);
    out = await tool("handle_dialog", { accept: false });
    assert.match(out.text, /Dismissed confirm/);
    assert.match(out.text, /confirm:false/);

    // downloads
    out = await tool("click", { ref: ref(out.text, /link "Download report" \[ref=(e\d+)\]/) });
    out = await tool("wait_for_download", { timeout: 20 });
    assert.equal(out.isError, false, out.text);
    const file = out.text.match(/Path: (.+)/)?.[1].trim() ?? "";
    assert.match(file, /report\.txt$/);
    assert.equal(readFileSync(file, "utf8"), "quarterly report\n");

    // cross-origin iframe: snapshot reaches it, type + click inside it, element screenshot
    page = (await tool("snapshot")).text;
    await tool("type", { ref: ref(page, /textbox "Frame field" \[ref=(e\d+)\]/), text: "inside" });
    out = await tool("click", { ref: ref(page, /button "Frame submit" \[ref=(e\d+)\]/) });
    assert.match(out.text, /frame got:inside/);
    const shot = await tool("screenshot", { ref: ref(out.text, /button "Frame submit" \[ref=(e\d+)\]/) });
    assert.equal(shot.raw.content[0].type, "image");
    assert.ok(Buffer.from(shot.raw.content[0].data, "base64").length > 100);

    // tab_info / reload / go_back / go_forward
    assert.match((await tool("tab_info")).text, /Tab: t1[\s\S]*Open tabs: 1/);
    assert.match((await tool("reload")).text, /Bots fixture/);
    await tool("navigate", { url: `${server.origin}/products` });
    assert.match((await tool("go_back")).text, /Bots fixture/);
    assert.match((await tool("go_forward")).text, /Page: Products/);

    // export_session / import_session
    const session_file = join(work, "session.json");
    await tool("evaluate", { expression: "document.cookie = 'sid=abc123; path=/; max-age=3600'" });
    out = await tool("export_session", { path: session_file, domains: ["127.0.0.1"] });
    assert.match(out.text, /Saved [1-9]\d* cookies and localStorage of 1 origin/);
    assert.doesNotMatch(out.text, /abc123|tok-123/);
    const saved = JSON.parse(readFileSync(session_file, "utf8"));
    assert.ok(saved.cookies.some((cookie: any) => cookie.name === "sid" && cookie.value === "abc123"));
    assert.equal(saved.origins[server.origin].localStorage.session_token, "tok-123");
    await tool("evaluate", { expression: "document.cookie = 'sid=; max-age=0; path=/'; localStorage.clear(); 1" });
    assert.match((await tool("import_session", { path: session_file })).text, /Restored [1-9]\d* cookies and 1 localStorage/);
    out = await tool("evaluate", { expression: "document.cookie + '|' + localStorage.getItem('session_token')" });
    assert.match(out.text, /sid=abc123.*\|tok-123/);

    // localStorage of an origin no tab has open is restored too (DOMStorage
    // needs a frame of that origin), and export reads every open tab's origin.
    const other_origin = server.origin.replace("127.0.0.1", "localhost");
    const other_file = join(work, "other-origin.json");
    writeFileSync(other_file, JSON.stringify({ version: 1, cookies: [], origins: { [other_origin]: { localStorage: { other_key: "other-value" } } } }));
    out = await tool("import_session", { path: other_file });
    assert.match(out.text, /Restored 0 cookies and 1 localStorage/);
    assert.doesNotMatch(out.text, /NOT restored/);
    assert.doesNotMatch((await tool("list_tabs")).text, /localhost/);
    out = await tool("new_tab", { url: `${other_origin}/` });
    const other_tab = out.text.match(/Tab: (t\d+)/)?.[1] ?? "";
    assert.match((await tool("evaluate", { expression: "localStorage.getItem('other_key')" })).text, /other-value/);
    await tool("switch_tab", { id: "t1" });
    out = await tool("export_session", { path: session_file });
    assert.match(out.text, /localStorage of 2 origin/);
    await tool("close_tab", { id: other_tab });

    // manual dialogs: evaluate that opens alert() returns at once instead of timing out
    out = await tool("evaluate", { expression: "setTimeout(() => 0); alert('from evaluate'); 1", world: "main" });
    assert.match(out.text, /An? alert dialog is open/);
    assert.match((await tool("handle_dialog", { accept: true })).text, /Accepted alert/);

    // a second Chrome on the same profile gets a clear error
    const intruder = new Browser({ chromePath: chrome, headless: true, userDataDir: profile, warnOnDirectEgress: false });
    await assert.rejects(intruder.launch(), (error: unknown) => error instanceof BrowserError && /already in use by another Chrome/.test(String((error as Error).message)));
    assert.ok(profileInUse(profile));

    // close_browser, then the next call relaunches on the same profile (cookies kept)
    assert.match((await tool("close_browser")).text, /Browser closed/);
    assert.equal(profileInUse(profile), null);
    out = await tool("navigate", { url: `${server.origin}/bots` });
    assert.equal(out.isError, false, out.text);
    assert.match((await tool("evaluate", { expression: "document.cookie" })).text, /sid=abc123/);
    assert.ok(existsSync(join(work, "downloads")));
  });

  test("relaunches when Chrome dies under it", async () => {
    const { tool } = client;
    await tool("navigate", { url: `${server.origin}/products` });
    // Kill the browser behind the server's back (what a crash or the user closing the window looks like).
    const lock = profileInUse(profile);
    assert.ok(lock);
    const browser_pid = await find_chrome_pid(profile);
    assert.ok(browser_pid, "chrome pid for profile");
    process.kill(browser_pid);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const out = await tool("navigate", { url: `${server.origin}/products` });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /relaunched on the same profile/);
    assert.match(out.text, /Page: Products/);
  });
});

describe("mcp red team over stdio (e2e)", { skip: chrome ? false : "Chrome not found" }, () => {
  let server: FixtureServer;
  let client: Client;
  let profile: string;
  let work: string;

  before(async () => {
    server = await startFixtureServer();
    profile = mkdtempSync(join(tmpdir(), "bs-red-profile-"));
    work = mkdtempSync(join(tmpdir(), "bs-red-work-"));
    client = await start_client(["--user-data-dir", profile, "--allowed-domains", "127.0.0.1", "--downloads-dir", join(work, "downloads")]);
  });

  after(async () => {
    await client?.stop();
    await server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  test("hostile page: dialog spam, popup storm, ambiguous uploads, traversal downloads, escapes", async () => {
    const { tool } = client;
    let page = (await tool("navigate", { url: `${server.origin}/hostile` })).text;

    // 60 alerts are auto-accepted and reported as a bounded, untrusted notes block.
    let out = await tool("click", { ref: ref(page, /button "Spam alerts" \[ref=(e\d+)\]/) });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /spam done/);
    const note_lines = out.text.split("\n").filter((line) => /^- Dialog on t\d+ auto-accepted/.test(line));
    assert.ok(note_lines.length <= 20, `${note_lines.length} note lines`);
    assert.match(out.text, /earlier note\(s\) dropped/);
    assert.match(out.text, /Notes:\n<untrusted-page-content>[\s\S]*spam 59/);

    // window.open storm: summarized, every tab still listed.
    out = await tool("click", { ref: ref(out.text, /button "Open many" \[ref=(e\d+)\]/) });
    // (Chrome's popup blocker lets one window.open per click through; the
    // storm summary itself is covered by the unit tests.)
    assert.match(out.text, /Notes:\n<untrusted-page-content>\n- The site opened a new tab t2/);

    // upload through a button that opens no chooser, with two file inputs: refuse to guess.
    const cv = join(work, "cv.pdf");
    writeFileSync(cv, "%PDF");
    page = (await tool("snapshot")).text;
    out = await tool("upload_file", { ref: ref(page, /button "Attach" \[ref=(e\d+)\]/), paths: [cv] });
    assert.equal(out.isError, true);
    assert.match(out.text, /has 2 <input type=file>/);
    out = await tool("upload_file", { ref: ref(page, /button "Attach" \[ref=(e\d+)\]/), paths: ["cv.pdf"] });
    assert.match(out.text, /must be absolute/);

    // a download named ../../evil.txt stays inside the downloads folder.
    await tool("click", { ref: ref(page, /link "Evil download" \[ref=(e\d+)\]/) });
    out = await tool("wait_for_download", { timeout: 20 });
    assert.equal(out.isError, false, out.text);
    const file = out.text.match(/Path: (.+)/)?.[1].trim() ?? "";
    assert.equal(dirname(file), join(work, "downloads"));
    assert.equal(readFileSync(file, "utf8"), "evil\n");

    // evaluate cannot be used to escape the allowed domains.
    out = await tool("evaluate", { expression: `location.href = ${JSON.stringify(`${server.crossOrigin}/products`)}; 1` });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    out = await tool("evaluate", { expression: "location.host" });
    assert.doesNotMatch(out.text, /localhost/);

    // wait_for: bad selector fails fast; non-numeric timeout does not hang.
    out = await tool("wait_for", { selector: "div[[", timeout: 30 });
    assert.match(out.text, /Invalid CSS selector/);

    // export_session is scoped to the allowed domains and never overwrites other files.
    const other = join(work, "notes.json");
    writeFileSync(other, "{\"keep\":true}");
    out = await tool("export_session", { path: other });
    assert.match(out.text, /Refusing to overwrite/);
    assert.equal(readFileSync(other, "utf8"), "{\"keep\":true}");
    out = await tool("export_session", { path: join(work, "s.json"), domains: ["google.com"] });
    assert.match(out.text, /not in the allowed domains/);
    out = await tool("export_session", { path: join(work, "s.json") });
    assert.match(out.text, /domains: 127\.0\.0\.1/);
    writeFileSync(join(work, "bad.json"), "null");
    out = await tool("import_session", { path: join(work, "bad.json") });
    assert.match(out.text, /not a session file/);
  });
});

// Main Chrome process for a profile: the one whose command line has the
// user-data-dir and no --type= (helpers carry --type=renderer/gpu/…).
async function find_chrome_pid(profile: string): Promise<number | null> {
  const { execSync } = await import("node:child_process");
  if (process.platform === "win32") {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`, { encoding: "utf8" });
    const list = [].concat(JSON.parse(out || "[]"));
    const main = list.find((proc: any) => String(proc.CommandLine ?? "").includes(profile) && !String(proc.CommandLine).includes("--type="));
    return main ? Number((main as any).ProcessId) : null;
  }
  const out = execSync("ps -eo pid=,args=", { encoding: "utf8" });
  for (const line of out.split("\n")) {
    if (line.includes(`--user-data-dir=${profile}`) && !line.includes("--type=")) {
      return Number(line.trim().split(/\s+/)[0]);
    }
  }
  return null;
}
