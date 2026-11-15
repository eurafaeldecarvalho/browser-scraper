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
  // Turnstile look-alike: two widgets (a responsive duplicate parked off-screen
  // FIRST in DOM order, then the visible one), each a closed-shadow container
  // holding a cross-origin iframe plus a light-DOM response input — like
  // nowsecure.nl. A click mints the test-sitekey "XXXX.DUMMY.TOKEN.XXXX".
  "/turnstile": (cross) => `<!doctype html><html><head><title>Turnstile fixture</title></head><body>
    <div class="cf-turnstile" id="w0" style="position:absolute;top:-200px;left:0"><input type="hidden" name="cf-turnstile-response"></div>
    <h1>Turnstile fixture</h1>
    <div class="cf-turnstile" id="w1"><input type="hidden" name="cf-turnstile-response"></div>
    <script>
      for (const id of ["w0", "w1"]) {
        const root = document.getElementById(id).attachShadow({ mode: "closed" });
        root.innerHTML = '<iframe src="${cross}/turnstile-frame?w=' + id + '" width="300" height="65" style="border:0"></iframe>';
      }
      addEventListener("message", (e) => {
        if (e.data && e.data.ua) document.body.dataset.frameUa = e.data.ua;
        if (e.data && e.data.widget) document.querySelector("#" + e.data.widget + " input").value = e.data.token;
      });
    </script>
  </body></html>`,
  "/turnstile-frame": () => `<!doctype html><html><body><div id="host"></div><script>
    const w = new URLSearchParams(location.search).get("w");
    const root = document.getElementById("host").attachShadow({ mode: "closed" });
    root.innerHTML = '<label><input type="checkbox"> Verify you are human</label><span hidden>Success!</span>';
    root.querySelector("input").addEventListener("click", () => {
      root.querySelector("label").hidden = true;
      root.querySelector("span").hidden = false;
      parent.postMessage({ widget: w, token: "XXXX.DUMMY.TOKEN.XXXX" }, "*");
    });
    parent.postMessage({ ua: navigator.userAgent }, "*");
  </script></body></html>`,
  "/popup": () => `<!doctype html><html><head><title>Opener</title></head><body><h1>Opener</h1><a href="/products" target="_blank">Open products</a></body></html>`,
  "/bots": (cross) => `<!doctype html><html><head><title>Bots fixture</title></head><body style="min-height:3000px">
<h1>Bots fixture</h1>
<label>Country <select id="country"><option value="">Choose</option><option value="br">Brazil</option><option value="pt">Portugal</option></select></label>
<div><button id="combo" role="combobox" aria-expanded="false" aria-controls="lb" onclick="document.getElementById('lb').hidden=false;this.setAttribute('aria-expanded','true')">Pick a color</button>
<ul id="lb" role="listbox" hidden><li role="option" tabindex="-1" onclick="document.getElementById('combo').textContent='Color: '+this.textContent;this.parentNode.hidden=true">Red</li><li role="option" tabindex="-1" onclick="document.getElementById('combo').textContent='Color: '+this.textContent;this.parentNode.hidden=true">Blue</li></ul></div>
<input type="file" id="cv" style="display:none" onchange="document.getElementById('cvname').textContent='file:'+this.files[0].name+':'+this.files[0].size">
<button onclick="document.getElementById('cv').click()">Upload CV</button><span id="cvname"></span>
<div id="hov" style="width:200px;height:40px;background:#eee" onmouseenter="document.getElementById('hovout').textContent='Hover menu open'">Hover me</div><span id="hovout"></span>
<label><input type="checkbox" id="terms"> Accept terms</label>
<label><input type="radio" name="plan" value="a"> Plan A</label><label><input type="radio" name="plan" value="b"> Plan B</label>
<label>Name <input id="name" value="old value"></label>
<label>City <input id="city"></label>
<label>OTP <input id="otp" onpaste="event.preventDefault();document.getElementById('otpout').textContent='pasted:'+event.clipboardData.getData('text/plain')"></label><span id="otpout"></span>
<label>Notes <input id="notes"></label>
<button onclick="setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='Ready later!';document.body.appendChild(p)},1500)">Show later</button>
<button onclick="location.hash='step2'">Go step 2</button>
<button onclick="document.getElementById('dlg').textContent='confirm:'+confirm('Delete everything?')">Ask confirm</button><span id="dlg"></span>
<a href="/download.txt">Download report</a>
<div id="feed" style="height:150px;overflow:auto;border:1px solid #000"></div>
<iframe id="xf" src="${cross}/form-frame" style="width:400px;height:120px"></iframe>
<script>
localStorage.setItem('session_token','tok-123');
const feed=document.getElementById('feed');let n=0;
function more(){for(let i=0;i<10&&n<50;i++){const d=document.createElement('div');d.className='item';d.style.height='40px';d.textContent='Item '+(++n);feed.appendChild(d)}}
more();feed.addEventListener('scroll',()=>{if(feed.scrollTop+feed.clientHeight>=feed.scrollHeight-20)setTimeout(more,200)});
</script></body></html>`,
  "/form-frame": () => `<!doctype html><html><body><label>Frame field <input id="ff"></label><button onclick="document.getElementById('fo').textContent='frame got:'+document.getElementById('ff').value">Frame submit</button><p id="fo"></p></body></html>`,
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
    if (path === "/download.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
      res.end("quarterly report\n");
      return;
    }
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
