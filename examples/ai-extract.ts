// LLM extraction with a self-healing, LLM-free-after-the-first-page extractor.
//
//   npm i ai @ai-sdk/anthropic zod
//   ANTHROPIC_API_KEY=... pnpm tsx examples/ai-extract.ts https://books.toscrape.com/
//
// Swap the provider for openai(), google(), ollama()… — any Vercel AI SDK model.
import { existsSync } from "node:fs";

import { Browser } from "../src/index";
import { Extractor, generateExtractor } from "../src/ai/index";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const Books = z.array(
  z.object({
    title: z.string(),
    price: z.number(),
    inStock: z.boolean(),
    url: z.string(),
  }),
);

const PLAN = ".extractors/books.json";

async function main(): Promise<void> {
  const url = process.argv[2] ?? "https://books.toscrape.com/";
  const model = anthropic("claude-sonnet-5-5");
  const browser = new Browser({ headless: true });

  try {
    const tab = await browser.newTab();
    await tab.goto({ url });

    // First run: the model writes selectors (one call). Later runs: zero LLM calls.
    const extractor = existsSync(PLAN)
      ? await Extractor.load({ path: PLAN, schema: Books, model })
      : await generateExtractor({ tab, schema: Books, model, instructions: "One record per book on the page." });

    const { data, via } = await extractor.runOrHeal({ tab });
    console.log(`${data.length} books via ${via}`);
    console.table(data.slice(0, 5));

    const { mkdirSync } = await import("node:fs");
    mkdirSync(".extractors", { recursive: true });
    await extractor.save({ path: PLAN });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
