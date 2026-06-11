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
      console.log("  ^ software rendering detected — set spoofWebGL on cloud hosts");
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
