import { Browser } from "../src";

// Exercises the change-set-C API surface: addInitScript, history navigation,
// viewport emulation, PDF export, and the new Element methods.
async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = !has_display || ["1", "true", "yes"].includes((process.env.HEADLESS ?? "").toLowerCase());

  const browser = new Browser({ headless });
  const results: Array<[string, boolean]> = [];

  try {
    const tab = await browser.newTab();

    // addInitScript runs in the page's main world before page scripts. We mark
    // the (shared) DOM so the isolated-world evaluate can observe that it ran.
    await tab.addInitScript({
      source: "document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-init-marker', 'injected'));",
    });
    await tab.goto({ url: "https://example.com" });
    const marker = await tab.evaluate({ expression: "document.documentElement.getAttribute('data-init-marker')" });
    results.push(["addInitScript runs on new document", marker === "injected"]);

    // History navigation: example.com -> example.org -> back -> forward.
    await tab.goto({ url: "https://example.org" });
    await tab.back();
    const afterBack = await tab.evaluate({ expression: "location.host" });
    await tab.forward();
    const afterForward = await tab.evaluate({ expression: "location.host" });
    results.push(["back() returns to example.com", afterBack === "example.com"]);
    results.push(["forward() returns to example.org", afterForward === "example.org"]);

    await tab.reload();
    results.push(["reload() keeps the page", (await tab.evaluate({ expression: "location.host" })) === "example.org"]);

    // Viewport emulation.
    await tab.setViewport({ width: 820, height: 640 });
    const innerWidth = await tab.evaluate({ expression: "window.innerWidth" });
    results.push(["setViewport applies width", innerWidth === 820]);

    // Element methods against an injected form.
    await tab.evaluate({
      expression: `
        (() => {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.id = 'cb';
          document.body.appendChild(cb);
          const sel = document.createElement('select');
          sel.id = 'sel';
          for (const v of ['a', 'b', 'c']) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            sel.appendChild(o);
          }
          document.body.appendChild(sel);
        })()
      `,
    });

    const checkbox = await tab.find({ selector: "#cb" });
    await checkbox!.click();
    results.push(["isChecked() after click", (await checkbox!.isChecked()) === true]);

    const box = await checkbox!.boundingBox();
    results.push(["boundingBox() returns a rect", Boolean(box && box.width > 0 && box.height > 0)]);

    const tagName = await checkbox!.getProperty({ name: "tagName" });
    results.push(["getProperty(tagName)", tagName === "INPUT"]);

    const select = await tab.find({ selector: "#sel" });
    await select!.selectOption({ value: "b" });
    results.push(["selectOption() sets value", (await select!.getProperty({ name: "value" })) === "b"]);

    // PDF export.
    const pdf = await tab.pdf();
    results.push(["pdf() returns bytes", pdf.length > 1000 && pdf.subarray(0, 4).toString() === "%PDF"]);

    let allOk = true;
    for (const [label, ok] of results) {
      console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
      allOk = allOk && ok;
    }
    console.log(allOk ? "\nPASS: all API checks ok" : "\nFAIL: some API checks failed");
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
