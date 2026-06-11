import { Browser } from "../src";

// Validates the stealth hardening: evaluate() still works without Runtime.enable,
// navigator.webdriver is hidden, and the User-Agent / client hints are clean.
async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = !has_display || ["1", "true", "yes"].includes((process.env.HEADLESS ?? "").toLowerCase());

  const browser = new Browser({ headless });

  try {
    const tab = await browser.newTab();
    await tab.goto({ url: "https://example.com" });

    const webdriver = await tab.evaluate({ expression: "navigator.webdriver" });
    const ua = await tab.evaluate({ expression: "navigator.userAgent" });
    const brands = await tab.evaluate({
      expression: "JSON.stringify((navigator.userAgentData && navigator.userAgentData.brands) || [])",
    });
    const heading = await tab.find({ selector: "h1" });
    const headingText = await heading?.text();

    console.log("navigator.webdriver:", webdriver);
    console.log("userAgent:", ua);
    console.log("uaData.brands:", brands);
    console.log("h1 text:", headingText);

    const uaHasHeadless = typeof ua === "string" && ua.includes("Headless");
    const brandsHasHeadless = typeof brands === "string" && brands.includes("Headless");

    const ok =
      (webdriver === false || webdriver === undefined || webdriver === null) &&
      !uaHasHeadless &&
      !brandsHasHeadless &&
      headingText === "Example Domain";

    console.log(ok ? "\nPASS: stealth checks ok" : "\nFAIL: a stealth check did not pass");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
