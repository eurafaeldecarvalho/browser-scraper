import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBlock, extractMetadata, htmlToMarkdown } from "../../src/index";

const ARTICLE = `<!doctype html><html lang="pt-BR"><head>
<title>Doc title</title>
<meta name="description" content="Desc">
<meta property="og:title" content="OG title"><meta property="og:image" content="/img.png">
<link rel="canonical" href="/canon">
<script type="application/ld+json">{"@type":"Product","name":"X"}</script>
<script type="application/ld+json">{ broken json</script>
</head><body>
<nav class="menu"><a href="/a">A</a><a href="/b">B</a></nav>
<header><a href="/">Logo</a></header>
<main>
  <h1>Main &amp; title</h1>
  <p>Some <b>bold </b>text and <em>emphasis</em> with a <a href="/rel">relative link</a> and an image <img src="/i.png" alt="Pic">. This paragraph is long enough to count as main content for the heuristic.</p>
  <ol start="3"><li>three</li><li>four<ul><li>nested</li></ul></li></ol>
  <table><thead><tr><th>A</th><th>B|C</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
  <pre><code class="language-ts">let a = 1;
let b = 2;</code></pre>
  <blockquote><p>Quoted</p></blockquote>
  <div hidden>hidden text</div>
  <div style="display: none">also hidden</div>
  <p><span>$10.00</span><span>In stock</span></p>
</main>
<div class="cookie-banner">We use cookies <a href="/c">ok</a></div>
<footer>Footer</footer>
</body></html>`;

test("htmlToMarkdown converts the main content", () => {
  const { markdown, title, links } = htmlToMarkdown(ARTICLE, { baseUrl: "https://site.test/page" });
  assert.equal(title, "Doc title");
  assert.match(markdown, /^# Main & title/);
  assert.match(markdown, /Some \*\*bold\*\* text and \*emphasis\*/);
  assert.match(markdown, /\[relative link\]\(https:\/\/site\.test\/rel\)/);
  assert.match(markdown, /!\[Pic\]\(https:\/\/site\.test\/i\.png\)/);
  assert.match(markdown, /3\. three\n4\. four\n  - nested/);
  assert.match(markdown, /\| A \| B\\\|C \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(markdown, /```ts\nlet a = 1;\nlet b = 2;\n```/);
  assert.match(markdown, /> Quoted/);
  assert.match(markdown, /\$10\.00 In stock/);
  assert.doesNotMatch(markdown, /hidden text|also hidden|Footer|cookies|Logo/);
  assert.deepEqual(links.map((l) => l.href), ["https://site.test/rel"]);
});

test("htmlToMarkdown link modes and mainContent:false", () => {
  const reference = htmlToMarkdown(ARTICLE, { links: "reference", baseUrl: "https://site.test/" }).markdown;
  assert.match(reference, /\[relative link\]\[1\]/);
  assert.match(reference, /\[1\]: https:\/\/site\.test\/rel$/);

  const none = htmlToMarkdown(ARTICLE, { links: "none", images: false }).markdown;
  assert.doesNotMatch(none, /\]\(/);

  const full = htmlToMarkdown(ARTICLE, { mainContent: false }).markdown;
  assert.match(full, /Footer/);
});

test("query keeps only relevant blocks plus their heading", () => {
  const html = `<main><h1>Store</h1><p>Welcome to the store, we sell many things.</p><h2>Shipping</h2><p>Shipping takes 3 days.</p><h2>Pricing</h2><p>The price is 10 dollars per unit.</p><p>Unrelated text about our history and team.</p></main>`;
  const md = htmlToMarkdown(html, { mainContent: false, query: "price" }).markdown;
  assert.match(md, /## Pricing\n\nThe price is 10 dollars/);
  assert.doesNotMatch(md, /Shipping takes|history/);
});

test("nested layout tables render once, as blocks", () => {
  const html = `<body><table><tr><td><table><tr><td>Logo</td><td>Menu</td></tr></table></td></tr>
    <tr><td><table><tr><td>1.</td><td><a href="/a">Story A</a></td></tr><tr><td></td><td>10 points</td></tr></table></td></tr></table></body>`;
  const md = htmlToMarkdown(html, { mainContent: false }).markdown;
  assert.equal(md.match(/Story A/g)?.length, 1);
  assert.match(md, /Logo Menu/);
  assert.match(md, /\| 1\. \| \[Story A\]\(\/a\) \|\n\| --- \| --- \|\n\|  \| 10 points \|/);
});

test("extractMetadata reads OG, canonical, lang and JSON-LD", () => {
  const meta = extractMetadata(ARTICLE, "https://site.test/x");
  assert.equal(meta.title, "OG title");
  assert.equal(meta.description, "Desc");
  assert.equal(meta.canonical, "https://site.test/canon");
  assert.equal(meta.lang, "pt-BR");
  assert.equal(meta.image, "https://site.test/img.png");
  assert.deepEqual(meta.jsonLd, [{ "@type": "Product", name: "X" }]);
});

test("detectBlock flags challenges, error statuses and app shells", () => {
  assert.equal(detectBlock({ status: 403, html: "<html></html>" }), "HTTP 403");
  assert.match(String(detectBlock({ status: 200, html: "<html><head><title>Just a moment...</title></head><body></body></html>" })), /challenge/);
  assert.match(String(detectBlock({ status: 200, html: '<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>' })), /JavaScript/);
  assert.equal(detectBlock({ status: 200, html: ARTICLE }), null);
  // A long article that merely mentions Cloudflare is not a challenge.
  const long = `<html><body><main><h1>How Cloudflare works</h1><p>${"cf-turnstile challenges.cloudflare.com explained. ".repeat(80)}</p></main></body></html>`;
  assert.equal(detectBlock({ status: 200, html: long }), null);
});
