import { Browser } from "../src";

// Audits the browser against public bot-detection test pages and prints what
// they flag. rebrowser bot-detector specifically probes CDP leaks (Runtime
// .enable, main-world access, exposeFunction, sourceUrl); sannysoft is the
// classic fingerprint table.
async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = !has_display || ["1", "true", "yes"].includes((process.env.HEADLESS ?? "").toLowerCase());

  const browser = new Browser({ headless });

  try {
    const tab = await browser.newTab();

    // --- rebrowser bot-detector: CDP leak tests ---
    console.log("\n=== bot-detector.rebrowser.net (CDP leaks) ===");
    await tab.goto({ url: "https://bot-detector.rebrowser.net/", waitUntil: "networkidle2", timeout: 45_000 });
    await tab.sleep({ milliseconds: 6_000 });

    const rebrowser = await tab.evaluate({
      expression: `
        (() => {
          const rows = Array.from(document.querySelectorAll('table tr, .test, li'));
          const lines = [];
          for (const r of rows) {
            const t = (r.innerText || '').replace(/\\s+/g, ' ').trim();
            if (t) lines.push(t);
          }
          return JSON.stringify(lines.slice(0, 40));
        })()
      `,
    });
    console.log(rebrowser);
    await tab.screenshot({ path: "detection-rebrowser.png", fullPage: true });

    // --- sannysoft fingerprint table ---
    console.log("\n=== bot.sannysoft.com (fingerprint) ===");
    await tab.goto({ url: "https://bot.sannysoft.com/", waitUntil: "networkidle2", timeout: 45_000 });
    await tab.sleep({ milliseconds: 5_000 });

    const sannysoft = await tab.evaluate({
      expression: `
        (() => {
          const out = [];
          for (const row of Array.from(document.querySelectorAll('tr'))) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 2) continue;
            const name = (cells[0].innerText || '').replace(/\\s+/g, ' ').trim();
            const valCell = cells[1];
            const val = (valCell.innerText || '').replace(/\\s+/g, ' ').trim();
            const cls = valCell.className || '';
            const failed = /fail|warn/i.test(cls) || /red/i.test(getComputedStyle(valCell).backgroundColor);
            if (name) out.push((failed ? 'FAIL ' : 'ok   ') + name + ': ' + val.slice(0, 40));
          }
          return JSON.stringify(out);
        })()
      `,
    });
    const rows: string[] = JSON.parse(typeof sannysoft === "string" ? sannysoft : "[]");
    for (const row of rows) {
      console.log(row);
    }
    const failures = rows.filter((r) => r.startsWith("FAIL"));
    console.log(`\nsannysoft failures: ${failures.length}`);
    await tab.screenshot({ path: "detection-sannysoft.png", fullPage: true });

    // --- Environment signals worth eyeballing ---
    console.log("\n=== environment signals ===");
    const webrtc = await tab.evaluate({
      expression: "typeof RTCPeerConnection === 'function' ? 'present' : 'blocked'",
    });
    console.log("WebRTC RTCPeerConnection:", webrtc);
    // WebGL read from the main world (where detectors read it).
    await tab.evaluate({
      expression: `
        (() => {
          const s = document.createElement('script');
          s.textContent = "try{var gl=document.createElement('canvas').getContext('webgl');var e=gl.getExtension('WEBGL_debug_renderer_info');document.documentElement.setAttribute('data-gpu', gl.getParameter(e.UNMASKED_RENDERER_WEBGL));}catch(x){document.documentElement.setAttribute('data-gpu','err');}";
          document.documentElement.appendChild(s);
          s.remove();
        })()
      `,
    });
    const gpu = await tab.evaluate({ expression: "document.documentElement.getAttribute('data-gpu')" });
    console.log("WebGL renderer (main world):", gpu);
    if (typeof gpu === "string" && /swiftshader|llvmpipe|software/i.test(gpu)) {
      console.log("  ^ software rendering detected — set spoofWebGL (or run a real GPU) on cloud hosts");
    }

    // --- Evasion integrity: do our patches read as native + stay consistent? ---
    // Runs in the MAIN world (where detectors read) via an injected <script>, so
    // it sees the addScriptToEvaluateOnNewDocument patches, not the isolated world.
    console.log("\n=== evasion integrity (main world) ===");
    const probe = `(function(){
      try {
        var out = {};
        var nat = function(fn){ try { return Function.prototype.toString.call(fn).indexOf('[native code]') !== -1; } catch(e){ return false; } };
        var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        out.webdriver_value = navigator.webdriver;
        out.webdriver_present = ('webdriver' in navigator);
        out.webdriver_is_getter = !!(d && typeof d.get === 'function');
        try { document.createElement('canvas').getContext('webgl'); out.getParameter_native = nat(WebGLRenderingContext.prototype.getParameter); } catch(e){ out.getParameter_native = null; }
        out.permissions_query_native = nat(navigator.permissions && navigator.permissions.query);
        out.notification_permission = (window.Notification && Notification.permission) || null;
        out.hardwareConcurrency = navigator.hardwareConcurrency;
        out.deviceMemory = navigator.deviceMemory;
        out.outerWidth = window.outerWidth;
        out.outerHeight = window.outerHeight;
        out.screen = window.screen.width + 'x' + window.screen.height;
        out.uadata_platform = (navigator.userAgentData && navigator.userAgentData.platform) || null;
        out.ua = navigator.userAgent;
        document.documentElement.setAttribute('data-integrity', JSON.stringify(out));
        if (navigator.permissions && navigator.permissions.query) {
          navigator.permissions.query({name:'notifications'}).then(function(p){ document.documentElement.setAttribute('data-perm-state', p.state); }).catch(function(){});
        }
        try {
          var code = 'self.postMessage({hc: navigator.hardwareConcurrency, dm: navigator.deviceMemory})';
          var w = new Worker(URL.createObjectURL(new Blob([code], {type:'text/javascript'})));
          w.onmessage = function(ev){ document.documentElement.setAttribute('data-worker', JSON.stringify(ev.data)); w.terminate(); };
        } catch(e){ document.documentElement.setAttribute('data-worker', 'err'); }
      } catch(e){ document.documentElement.setAttribute('data-integrity', 'err:'+(e && e.message)); }
    })();`;

    await tab.evaluate({
      expression: `(() => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(probe)}; document.documentElement.appendChild(s); s.remove(); })()`,
    });
    // Poll for the async worker reading instead of a fixed sleep — a missing
    // reading must read as a FAIL, never a silent PASS.
    try {
      await tab.waitForFunction({
        expression: "document.documentElement.getAttribute('data-worker') !== null",
        timeout: 3_000,
      });
    } catch {
      // Worker never reported — handled as a FAIL below.
    }

    const integrityRaw = await tab.evaluate({ expression: "document.documentElement.getAttribute('data-integrity')" });
    const permState = await tab.evaluate({ expression: "document.documentElement.getAttribute('data-perm-state')" });
    const workerRaw = await tab.evaluate({ expression: "document.documentElement.getAttribute('data-worker')" });

    try {
      const it = JSON.parse(typeof integrityRaw === "string" ? integrityRaw : "{}");
      const worker = JSON.parse(typeof workerRaw === "string" && workerRaw.startsWith("{") ? workerRaw : "{}");
      const line = (ok: boolean, label: string, value: unknown) => console.log(`${ok ? "ok   " : "FAIL "}${label}: ${String(value)}`);

      line(it.webdriver_present === true && it.webdriver_value === false, "navigator.webdriver present && false", `${it.webdriver_value} (getter=${it.webdriver_is_getter})`);
      line(it.getParameter_native !== false, "WebGL getParameter toString native", it.getParameter_native);
      line(it.permissions_query_native !== false, "permissions.query toString native", it.permissions_query_native);
      // Valid coherence: query state must be a real PermissionState, and
      // Notification.permission 'default' maps to query 'prompt'.
      const validState = ["granted", "denied", "prompt"].includes(String(permState));
      const mapped = (it.notification_permission === "default" && permState === "prompt") || it.notification_permission === permState;
      line(validState && mapped, "Notification.permission <-> permissions.query coherent", `${it.notification_permission} <-> ${permState}`);
      line(it.outerWidth > 0 && it.outerHeight > 0, "window.outerWidth/Height non-zero", `${it.outerWidth}x${it.outerHeight}`);
      const uaPlat = /Linux/.test(it.ua) ? "Linux" : /Windows/.test(it.ua) ? "Windows" : /Mac/.test(it.ua) ? "macOS" : "?";
      line(!it.uadata_platform || it.uadata_platform === uaPlat, "userAgentData.platform matches UA OS", `${it.uadata_platform} vs ${uaPlat}`);
      // Worker readings MUST be present (missing => the probe didn't run => FAIL).
      const hcPresent = typeof worker.hc === "number";
      line(hcPresent && worker.hc === it.hardwareConcurrency, "hardwareConcurrency main==worker", `${it.hardwareConcurrency} / ${hcPresent ? worker.hc : "MISSING"}`);
      const dmPresent = typeof worker.dm === "number";
      line(dmPresent && worker.dm === it.deviceMemory, "deviceMemory main==worker", `${it.deviceMemory} / ${dmPresent ? worker.dm : "MISSING"}`);
    } catch (error) {
      console.log("integrity parse error:", error, integrityRaw);
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
