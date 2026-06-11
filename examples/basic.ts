import { Browser } from "../src";

async function main(): Promise<void> {
  const browser = new Browser();

  try {
    const tab = await browser.newTab();
    await tab.goto({ url: "https://example.com" });

    const heading = await tab.find({ selector: "h1" });
    console.log(await heading?.text());

    await tab.screenshot({ path: "example.png" });
  } finally {
    await browser.close();
  }
}

void main();