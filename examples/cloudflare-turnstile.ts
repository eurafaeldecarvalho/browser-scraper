import { Browser } from "../src";

const DEFAULT_URL = "https://2captcha.com/demo/cloudflare-turnstile-challenge";

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

async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const force_headless = envFlag("HEADLESS", false);
  const headless = force_headless || !has_display;
  const target_url = process.env.TARGET_URL || DEFAULT_URL;
  const pause_ms = envNumber("PAUSE_MS", 20_000);
  const screenshot_path = process.env.SCREENSHOT_PATH || "cloudflare-turnstile.png";

  console.log(`URL: ${target_url}`);
  console.log(`DISPLAY detected: ${has_display}`);
  console.log(`Headless: ${headless}`);

  const browser = new Browser({
    headless,
    autoSeed: true,
    userDataDir: process.env.USER_DATA_DIR || null,
  });

  try {
    const tab = await browser.newTab();

    console.log("Opening page...");
    await tab.goto({ url: target_url, waitUntil: "networkidle2", timeout: 45_000 });

    console.log("Page loaded. Waiting for challenge iframe initialization...");
    await tab.sleep({ milliseconds: 4_000 });

    const checkbox = await tab.find({ selector: "input[type='checkbox']", timeout: 12_000 });
    if (checkbox) {
      console.log("Turnstile checkbox found.");
    } else {
      console.log("Turnstile checkbox not found yet.");
    }

    await tab.screenshot({ path: screenshot_path, fullPage: true });
    console.log(`Screenshot saved to ${screenshot_path}`);

    if (!headless) {
      console.log(`Keeping browser open for ${pause_ms}ms for manual inspection...`);
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