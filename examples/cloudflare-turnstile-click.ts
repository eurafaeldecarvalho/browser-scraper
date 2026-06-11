import { Browser } from "../src";

const DEFAULT_URL = "https://2captcha.com/demo/cloudflare-turnstile";

function envFlag(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function isRealToken(token: string | null | undefined): token is string {
  if (!token) {
    return false;
  }

  // The 2captcha demo seeds the field with a placeholder until solved; a real
  // Cloudflare token is long and never contains "DUMMY".
  return token.length > 30 && !token.toUpperCase().includes("DUMMY");
}

async function getTurnstileToken(tab: Awaited<ReturnType<Browser["newTab"]>>): Promise<string | null> {
  // Read the live value (not the static attribute) directly from the DOM,
  // covering the hidden cf-turnstile-response input wherever it sits.
  const token = await tab.evaluate({
    expression: `
      (() => {
        const el = document.querySelector("input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']");
        return el && el.value ? el.value : "";
      })()
    `,
  });

  return typeof token === "string" && token.trim().length > 0 ? token : null;
}

async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = envFlag("HEADLESS", false) || !has_display;
  const pause_ms = envNumber("PAUSE_MS", 20_000);
  const click_attempts = envNumber("CLICK_ATTEMPTS", 3);
  const target_url = process.env.TARGET_URL || DEFAULT_URL;
  const before_screenshot = process.env.BEFORE_SCREENSHOT || "cloudflare-turnstile-click-before.png";
  const after_screenshot = process.env.AFTER_SCREENSHOT || "cloudflare-turnstile-click-after.png";

  console.log(`URL: ${target_url}`);
  console.log(`DISPLAY detected: ${has_display}`);
  console.log(`Headless: ${headless}`);
  console.log(`Click attempts: ${click_attempts}`);

  const browser = new Browser({
    headless,
    autoSeed: true,
    userDataDir: process.env.USER_DATA_DIR || null,
  });

  try {
    const tab = await browser.newTab();

    console.log("Opening clickable Turnstile page...");
    await tab.goto({ url: target_url, waitUntil: "networkidle2", timeout: 45_000 });

    console.log("Waiting for Turnstile iframe initialization...");
    await tab.sleep({ milliseconds: 4_000 });

    await tab.screenshot({ path: before_screenshot, fullPage: true });
    console.log(`Before screenshot saved to ${before_screenshot}`);

    let clicked = false;
    let solved = false;
    for (let attempt = 1; attempt <= click_attempts; attempt += 1) {
      console.log(`Attempt ${attempt}: searching for checkbox...`);
      const checkbox = await tab.find({ selector: "input[type='checkbox']", timeout: 12_000 });

      if (!checkbox) {
        console.log("Checkbox not found on this attempt.");
        await tab.sleep({ milliseconds: 2_000 });
        continue;
      }

      console.log("Checkbox found. Clicking...");
      await checkbox.click();
      clicked = true;

      console.log("Waiting for the widget to resolve...");
      // The 2captcha demo keeps a static "XXXX.DUMMY.TOKEN.XXXX" placeholder in
      // the main document; the real token lives inside Cloudflare's cross-origin
      // iframe. Success is therefore detected by the widget being consumed: once
      // Turnstile validates, the checkbox collapses into the "Success!" state and
      // the input[type=checkbox] is gone from the (pierced) DOM.
      let token: string | null = null;
      for (let poll = 0; poll < 15; poll += 1) {
        await tab.sleep({ milliseconds: 1_000 });

        token = await getTurnstileToken(tab);
        if (isRealToken(token)) {
          break;
        }

        const still_there = await tab.find({ selector: "input[type='checkbox']", timeout: 1_000 });
        if (!still_there) {
          solved = true;
          break;
        }
      }

      if (isRealToken(token) || solved) {
        break;
      }

      console.log("Widget not resolved on this attempt.");
    }

    if (!clicked) {
      console.log("No click was executed because the checkbox was not found.");
    }

    const final_token = await getTurnstileToken(tab);
    if (isRealToken(final_token)) {
      console.log(`\nPASS: real Turnstile token captured (${final_token.length} chars).`);
      console.log(`Token: ${final_token}`);
      process.exitCode = 0;
    } else if (solved) {
      console.log("\nPASS: Turnstile challenge solved (widget reached the success state).");
      process.exitCode = 0;
    } else {
      console.log("\nFAIL: Turnstile widget did not resolve.");
      process.exitCode = 1;
    }

    await tab.screenshot({ path: after_screenshot, fullPage: true });
    console.log(`After screenshot saved to ${after_screenshot}`);

    if (!headless) {
      console.log(`Keeping browser open for ${pause_ms}ms for inspection...`);
      await tab.sleep({ milliseconds: pause_ms });
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});