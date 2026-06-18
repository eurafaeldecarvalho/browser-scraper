import { Browser, HttpClient } from "../src";

// Smoke test for the option-B additions: main-world execution, isolated-world
// isolation, Turnstile token reader, and the HTTP fast lane. Headless, no proxy.
async function main(): Promise<void> {
  // hardwareConcurrency:8 (≠ this box's real core count) so the worker check below
  // proves the override actually REACHES the worker, not just the main thread.
  const browser = new Browser({ headless: true, warnOnDirectEgress: false, hardwareConcurrency: 8 });
  let failures = 0;
  const ok = (label: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!cond) failures += 1;
  };

  try {
    const tab = await browser.newTab();

    // A page whose OWN main-world script sets a global. The isolated world has a
    // separate JS global, so it must NOT see it; the main world must.
    const page = "data:text/html," + encodeURIComponent("<script>window.__pageVar = 'page-main-world'</script><div class=x>hi</div>");
    await tab.goto({ url: page, waitUntil: "load", timeout: 15_000 });

    const isolated = await tab.evaluate({ expression: "typeof window.__pageVar" });
    ok("isolated world cannot see page global", isolated === "undefined", String(isolated));

    const mainWorld = await tab.evaluate({ expression: "window.__pageVar", world: "main" });
    ok("main world reads page global (no Runtime.enable)", mainWorld === "page-main-world", String(mainWorld));

    // Isolated world still sees the shared DOM.
    const domFromIsolated = await tab.evaluate({ expression: "document.querySelector('.x') && document.querySelector('.x').textContent" });
    ok("isolated world still sees the DOM", domFromIsolated === "hi", String(domFromIsolated));

    // No Turnstile widget on this page -> token reader returns null, solve gives up cleanly.
    const token = await tab.turnstileToken();
    ok("turnstileToken null with no widget", token === null, String(token));
    const solved = await tab.solveTurnstile({ timeoutMs: 3_000, attempts: 1 });
    ok("solveTurnstile returns unsolved cleanly with no widget", solved.solved === false && solved.token === null);

    // HTTP fast lane (Node fetch fallback, no proxy).
    const http: HttpClient = browser.createHttpClient();
    const res = await http.get("https://example.com/");
    ok("http fast-lane fetch 200", res.status === 200, `status=${res.status} impersonated=${res.impersonated}`);
    ok("http fast-lane body looks like the page", /Example Domain/i.test(res.body));

    // Regression (lib-todo item 3): a network event handler that THROWS — e.g.
    // while Chrome is dying or during teardown — must NOT escape as a fatal
    // unhandledRejection. CDP event dispatch now swallows handler rejections, and
    // Network gained off()/removeAllListeners() to drain handlers before close.
    let handlerFired = false;
    const throwing = tab.network.on({
      event: "response",
      handler: () => {
        handlerFired = true;
        throw new Error("boom from a network handler");
      },
    });
    await tab.goto({ url: "https://example.com/", waitUntil: "load", timeout: 20_000 }).catch(() => {});
    await tab.sleep({ milliseconds: 400 });
    tab.network.off({ event: "response", handler: throwing });
    tab.network.removeAllListeners();
    // Reaching this line at all means the throwing handler did not crash Node.
    ok("throwing network handler did not crash the process", true, `handlerFired=${handlerFired}`);

    // Worker fix: (1) a Web Worker must RUN (not hang paused under our
    // waitForDebuggerOnStart auto-attach), and (2) the hardwareConcurrency override
    // must REACH the worker (re-issued on the worker's own CDP session), so
    // navigator.hardwareConcurrency is coherent main↔worker. (tab is on example.com
    // here — clean origin, no CSP.)
    const WORKER_PROBE = `(() => new Promise((resolve) => {
      try {
        const code = 'self.postMessage({hc: navigator.hardwareConcurrency, dm: navigator.deviceMemory})';
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const w = new Worker(url);
        const t = setTimeout(() => resolve({ error: 'timeout' }), 5000);
        w.onmessage = (ev) => { clearTimeout(t); URL.revokeObjectURL(url); w.terminate(); resolve(ev.data); };
        w.onerror = (e) => { clearTimeout(t); resolve({ error: String((e && e.message) || 'worker error') }); };
      } catch (e) { resolve({ error: String(e && e.message) }); }
    }))()`;
    const mainHc = await tab.evaluate({ expression: "navigator.hardwareConcurrency" });
    const worker = await tab.evaluate({ expression: WORKER_PROBE });
    ok("Web Worker runs (not left paused/hung)", Boolean(worker) && typeof worker.hc === "number", JSON.stringify(worker));
    ok("hardwareConcurrency override reaches the worker (main==worker==8)", mainHc === 8 && Boolean(worker) && worker.hc === 8, `main=${mainHc} worker=${worker && worker.hc}`);

    // Proxy without curl-impersonate must throw (never silently leak host TLS/IP).
    let threw = false;
    try {
      const proxied = browser.createHttpClient({ proxy: "http://127.0.0.1:9" });
      await proxied.get("https://example.com/");
    } catch {
      threw = true;
    }
    ok("http fast-lane refuses proxy without curl-impersonate", threw);
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
