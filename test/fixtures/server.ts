import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Two origins on one server: 127.0.0.1 and localhost are different SITES, so an
// iframe from one inside the other is rendered out-of-process (OOPIF) by
// Chrome's site isolation — the case the library's piercing is built for.
export type FixtureServer = { origin: string; crossOrigin: string; close: () => Promise<void> };

const PAGES: Record<string, (cross: string) => string> = {
  "/article": (cross) => `<!doctype html>
<html lang="en">
<head>
  <title>Fixture Article</title>
  <meta name="description" content="A page used by the browser-scraper test-suite.">
  <meta property="og:title" content="Fixture Article OG">
  <meta property="og:image" content="/cover.png">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="/article">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget","offers":{"price":"19.90","priceCurrency":"BRL"}}</script>
</head>
<body>
  <nav class="navbar"><a href="/">Home</a> <a href="/about">About</a></nav>
  <main>
    <h1>Widget 3000</h1>
    <p>The <strong>Widget 3000</strong> is the best widget for <a href="/scraping">web scraping</a> workflows. It ships with batteries included and a long paragraph of text so that main-content detection keeps it around.</p>
    <h2>Pricing</h2>
    <p>Price: R$ 19,90 per month, billed yearly.</p>
    <ul><li>Fast</li><li>Stealthy<ul><li>Nested item</li></ul></li></ul>
    <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>19.90</td></tr></table>
    <pre><code class="language-js">const x = 1;</code></pre>
    <price-card id="card"><span slot="label">Secret price</span></price-card>
    <form><label for="email">Email</label><input id="email" name="email" type="email"><button type="button" id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('email').value">Continue</button></form>
    <p id="out"></p>
    <iframe id="cross" src="${cross}/frame" width="300" height="120"></iframe>
  </main>
  <footer class="footer">Copyright footer text</footer>
  <script>
    customElements.define("price-card", class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "closed" });
        root.innerHTML = '<div><h3>Shadow heading</h3><p>Hidden in a closed shadow root: <slot name="label"></slot></p><button id="shadow-btn">Shadow button</button></div>';
        root.getElementById("shadow-btn").addEventListener("click", () => { document.title = "shadow-clicked"; });
      }
    });
  </script>
</body>
</html>`,
  "/frame": () => `<!doctype html><html><body><h4>Cross-origin frame</h4><p>Content from another site.</p><button onclick="this.textContent='frame-clicked'">Frame button</button></body></html>`,
  "/blocked": () => `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div><script>window._cf_chl_opt={}</script></body></html>`,
  "/spa": () => `<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script>document.getElementById('root').innerHTML='<main><h1>Rendered by JS</h1><p>' + 'This content only exists after JavaScript runs. '.repeat(5) + '</p></main>'</script></body></html>`,
  "/products": () => `<!doctype html><html><head><title>Products</title></head><body><main><h1>Products</h1>
    <div class="product"><h2 class="name">Alpha</h2><span class="price">$10.00</span><span class="stock">In stock</span></div>
    <div class="product"><h2 class="name">Beta</h2><span class="price">$25.50</span><span class="stock">Sold out</span></div>
  </main></body></html>`,
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const host = req.headers.host ?? "";
    const port = host.split(":")[1];
    const page = PAGES[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(path === "/blocked" ? 403 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(`http://localhost:${port}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // localhost may resolve to ::1 first; listen on both by binding a second
  // listener is overkill — Chrome falls back to 127.0.0.1 for localhost.
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
