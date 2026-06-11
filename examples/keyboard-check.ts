import { Browser } from "../src";

// Validates real keyboard events: typed value, that keydown carries a proper
// keyCode (not 0), and that a named key like "Enter" is delivered.
async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = !has_display || ["1", "true", "yes"].includes((process.env.HEADLESS ?? "").toLowerCase());

  const browser = new Browser({ headless });

  try {
    const tab = await browser.newTab();
    await tab.goto({ url: "https://example.com" });

    await tab.evaluate({
      expression: `
        (() => {
          const input = document.createElement('input');
          input.id = 'kbd-test';
          document.body.appendChild(input);
          window.__keys = [];
          window.__enter = false;
          input.addEventListener('keydown', (e) => {
            window.__keys.push(e.keyCode);
            if (e.key === 'Enter') window.__enter = true;
          });
        })()
      `,
    });

    const input = await tab.find({ selector: "#kbd-test" });
    if (!input) {
      throw new Error("test input not found");
    }

    await input.type({ text: "Hello123" });
    await input.pressKey({ key: "Enter" });

    const value = await tab.evaluate({ expression: "document.getElementById('kbd-test').value" });
    const firstKeyCode = await tab.evaluate({ expression: "window.__keys[0] || 0" });
    const allKeys = await tab.evaluate({ expression: "JSON.stringify(window.__keys)" });
    const enterSeen = await tab.evaluate({ expression: "window.__enter === true" });

    console.log("typed value:", value);
    console.log("first keyCode:", firstKeyCode, "(H = 72)");
    console.log("all keyCodes:", allKeys);
    console.log("Enter delivered:", enterSeen);

    const ok = value === "Hello123" && firstKeyCode === 72 && enterSeen === true;
    console.log(ok ? "\nPASS: keyboard events ok" : "\nFAIL: keyboard check did not pass");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
