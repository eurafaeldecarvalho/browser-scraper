import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

import { Extractor, ExtractorMismatchError, extract, generateExtractor, runPlan, simplifyHtml, type ExtractionPlan, type LlmRequest } from "../../src/ai/index";
import { parse } from "node-html-parser";

const PRODUCTS = `<html><body><main>
  <div class="product" data-sku="A1"><h2 class="name">Alpha</h2><span class="price">R$ 1.234,56</span><span class="stock">In stock</span><a href="/p/a">more</a></div>
  <div class="product" data-sku="B2"><h2 class="name">Beta</h2><span class="price">$25.50</span><span class="stock">Sold out</span><a href="/p/b">more</a></div>
</main><script>evil()</script></body></html>`;

const LIST_PLAN: ExtractionPlan = {
  version: 1,
  kind: "list",
  root: "div.product",
  fields: [
    { name: "name", selector: ".name", attribute: null, type: "string" },
    { name: "price", selector: ".price", attribute: null, type: "number" },
    { name: "inStock", selector: ".stock", attribute: null, type: "boolean" },
    { name: "sku", selector: null, attribute: "data-sku", type: "string" },
  ],
};

const Products = z.array(z.object({ name: z.string(), price: z.number(), inStock: z.boolean(), sku: z.string() }));

test("runPlan extracts lists and parses localized numbers", () => {
  const data = runPlan(parse(PRODUCTS), LIST_PLAN);
  assert.deepEqual(data, [
    { name: "Alpha", price: 1234.56, inStock: true, sku: "A1" },
    { name: "Beta", price: 25.5, inStock: false, sku: "B2" },
  ]);
});

test("runPlan supports object kind, patterns and nested arrays", () => {
  const html = `<div id="p"><h1>Gamma</h1><p class="meta">Rating: 4.5 of 5</p><ul><li><a href="/t/x">x</a></li><li><a href="/t/y">y</a></li></ul><div class="v"><b>Red</b><i>10</i></div><div class="v"><b>Blue</b><i>12,5</i></div></div>`;
  const data = runPlan(parse(html), {
    version: 1,
    kind: "object",
    root: "#p",
    fields: [
      { name: "title", selector: "h1", type: "string" },
      { name: "rating", selector: ".meta", type: "number", pattern: "Rating: ([\\d.]+)" },
      { name: "tags", selector: "li a", type: "string[]" },
      { name: "variants", selector: ".v", type: "object[]", fields: [
        { name: "color", selector: "b", type: "string" },
        { name: "size", selector: "i", type: "number" },
      ] },
    ],
  });
  assert.deepEqual(data, { title: "Gamma", rating: 4.5, tags: ["x", "y"], variants: [{ color: "Red", size: 10 }, { color: "Blue", size: 12.5 }] });
});

test("simplifyHtml drops scripts and noise attributes", () => {
  const out = simplifyHtml(`<div class="a" style="color:red" onclick="x()" data-id="1"><script>bad()</script><svg><path/></svg>${"long ".repeat(50)}</div>`);
  assert.doesNotMatch(out, /script|svg|style=|onclick/);
  assert.match(out, /class="a"/);
  assert.match(out, /data-id="1"/);
  assert.ok(out.length < 200);
});

test("extract() with a custom llm function validates against the zod schema", async () => {
  const calls: LlmRequest[] = [];
  const data = await extract({
    html: PRODUCTS,
    schema: Products,
    llm: async (request) => {
      calls.push(request);
      return [{ name: "Alpha", price: 1234.56, inStock: true, sku: "A1" }];
    },
  });
  assert.equal(data[0].name, "Alpha");
  assert.match(calls[0].prompt, /Alpha/);
  assert.doesNotMatch(calls[0].prompt, /evil\(\)/);
  assert.equal((calls[0].schema as any).type, "array");

  await assert.rejects(
    extract({ html: PRODUCTS, schema: Products, llm: async () => [{ name: 1 }] }),
    /does not match the schema/,
  );
});

test("extract() with a Vercel AI SDK model", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ title: "Hello", count: 3 }) }],
      finishReason: { unified: "stop", raw: "stop" } as any,
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } as any,
      warnings: [],
    }),
  });
  const data = await extract({ model, schema: z.object({ title: z.string(), count: z.number() }), markdown: "# Hello\n3 items" });
  assert.deepEqual(data, { title: "Hello", count: 3 });
  assert.equal(model.doGenerateCalls.length, 1);
});

test("generateExtractor → run without LLM → save/load → self-heal", async () => {
  let llm_calls = 0;
  const llm = async (request: LlmRequest) => {
    llm_calls += 1;
    // The plan prompt carries the simplified HTML; answer with the right plan.
    assert.match(request.prompt, /class="product"/);
    return { kind: "list", root: "div.product", fields: LIST_PLAN.fields.map((f) => ({ ...f, pattern: null, fields: null })) };
  };

  const extractor = await generateExtractor({ html: PRODUCTS, schema: Products, llm });
  assert.equal(llm_calls, 1);
  const data = await extractor.run({ html: PRODUCTS });
  assert.equal(data.length, 2);
  assert.equal(llm_calls, 1, "run() must not call the LLM");

  const dir = mkdtempSync(join(tmpdir(), "bs-"));
  await extractor.save({ path: join(dir, "plan.json") });
  const loaded = await Extractor.load({ path: join(dir, "plan.json"), schema: Products, llm });
  assert.deepEqual(await loaded.run({ html: PRODUCTS }), data);

  // The site renames its classes: run() fails, runOrHeal() regenerates.
  const redesigned = PRODUCTS.replace(/class="product"/g, 'class="item"');
  await assert.rejects(loaded.run({ html: redesigned }), ExtractorMismatchError);
  const healing_llm = async (request: LlmRequest) => {
    assert.match(request.prompt, /previous extractor failed/i);
    return { kind: "list", root: "div.item", fields: LIST_PLAN.fields.map((f) => ({ ...f, pattern: null, fields: null })) };
  };
  const healer = new Extractor({ plan: loaded.plan, schema: Products, llm: healing_llm });
  const healed = await healer.runOrHeal({ html: redesigned });
  assert.equal(healed.via, "healed");
  assert.equal(healed.data.length, 2);
  assert.equal(healer.plan.root, "div.item");
});
