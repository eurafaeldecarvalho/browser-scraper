#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Browser, type BrowserOptions } from "./core/browser";
import { McpServer, parseEnvFile } from "./mcp/server";
import { scrape, ScrapeError, type ScrapeFormat } from "./scrape";
import { __version__ } from "./index";

const HELP = `browser-scraper ${__version__} — stealth browser for scraping and AI agents

Usage:
  browser-scraper scrape <url> [options]     Fetch a URL (http → browser → stealth)
  browser-scraper markdown <url> [options]   Print the page as clean Markdown
  browser-scraper snapshot <url> [options]   Print the accessibility snapshot with refs
  browser-scraper mcp [options]              Run the MCP server on stdio

Common options:
  --proxy <url>              http(s)://user:pass@host:port
  --headful                  Show the browser window (default: headless)
  --user-data-dir <dir>      Persistent Chrome profile
  --chrome-path <path>       Chrome binary (auto-detected otherwise)
  --geo <CC>                 Persona country, e.g. BR, US (timezone/locale)

scrape / markdown:
  --format <list>            markdown,metadata,links,html,screenshot (scrape; default markdown,metadata)
  --strategy <s>             auto | http | browser | stealth (default auto)
  --query <text>             Keep only the blocks relevant to this query
  --full                     Whole page instead of the main content
  --curl-impersonate <bin>   curl-impersonate binary for a real Chrome TLS fingerprint on the http tier
  --json                     Print the full result as JSON (scrape)
  --out <file>               Write the screenshot / output to a file

mcp:
  --allowed-domains <list>   Comma-separated; navigation elsewhere is refused
  --secrets <file>           .env file; the agent types values via {{NAME}} placeholders

Examples:
  npx @eurafaeldecarvalho/browser-scraper markdown https://example.com
  npx @eurafaeldecarvalho/browser-scraper scrape https://example.com --format markdown,metadata --json
  claude mcp add browser-scraper -- npx -y @eurafaeldecarvalho/browser-scraper mcp
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      proxy: { type: "string" },
      headful: { type: "boolean" },
      "user-data-dir": { type: "string" },
      "chrome-path": { type: "string" },
      geo: { type: "string" },
      format: { type: "string" },
      strategy: { type: "string" },
      query: { type: "string" },
      full: { type: "boolean" },
      "curl-impersonate": { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      "allowed-domains": { type: "string" },
      secrets: { type: "string" },
      interactive: { type: "boolean" },
    },
  });

  if (values.version) {
    process.stdout.write(`${__version__}\n`);
    return 0;
  }
  const [command, url] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }

  const browserOptions: BrowserOptions = {
    headless: !values.headful,
    proxy: values.proxy ?? null,
    userDataDir: values["user-data-dir"] ?? null,
    chromePath: values["chrome-path"] ?? null,
    geoCountry: values.geo ?? null,
    // CLI users get one clear warning from us instead of the library's.
    warnOnDirectEgress: false,
  };

  if (command === "mcp") {
    const server = new McpServer({
      browserOptions,
      allowedDomains: values["allowed-domains"]?.split(",").map((d) => d.trim()).filter(Boolean),
      secrets: values.secrets ? parseEnvFile(values.secrets) : undefined,
      version: __version__,
    });
    process.stderr.write(`[browser-scraper] MCP server ${__version__} on stdio\n`);
    await server.serve();
    return 0;
  }

  if (!url) {
    process.stderr.write(`Missing <url>.\n\n${HELP}`);
    return 1;
  }

  const markdown_options = { query: values.query, mainContent: !values.full };

  if (command === "scrape" || command === "markdown") {
    const formats = (command === "markdown" ? ["markdown"] : (values.format ?? "markdown,metadata").split(",")) as ScrapeFormat[];
    try {
      const result = await scrape({
        url,
        formats,
        strategy: (values.strategy as any) ?? "auto",
        browserOptions,
        http: values["curl-impersonate"] ? { curlImpersonate: values["curl-impersonate"] } : undefined,
        markdown: markdown_options,
      });

      if (result.screenshot) {
        const path = values.out ?? "screenshot.png";
        writeFileSync(path, result.screenshot);
        process.stderr.write(`screenshot → ${path}\n`);
      }

      if (command === "markdown") {
        emit(result.markdown ?? "", values.out);
      } else if (values.json) {
        const { screenshot: _screenshot, ...rest } = result;
        emit(JSON.stringify(rest, null, 2), formats.includes("screenshot") ? undefined : values.out);
      } else {
        const parts = [`<!-- ${result.url} · tier: ${result.tier} -->`];
        if (result.markdown) {
          parts.push(result.markdown);
        }
        if (result.metadata) {
          parts.push("```json\n" + JSON.stringify(result.metadata, null, 2) + "\n```");
        }
        if (result.links) {
          parts.push(result.links.map((link) => `- [${link.text}](${link.href})`).join("\n"));
        }
        if (result.html) {
          parts.push(result.html);
        }
        emit(parts.join("\n\n"), formats.includes("screenshot") ? undefined : values.out);
      }
      process.stderr.write(`[browser-scraper] ${result.tier} tier · ${result.attempts.map((a) => `${a.tier} ${a.ok ? "ok" : `✗ ${a.reason}`} ${a.ms}ms`).join(" → ")}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ScrapeError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  if (command === "snapshot") {
    const browser = new Browser(browserOptions);
    try {
      const tab = await browser.newTab();
      await tab.goto({ url });
      await tab.sleep({ milliseconds: 500 });
      emit(await tab.snapshot({ interactive: Boolean(values.interactive) }), values.out);
      return 0;
    } finally {
      await browser.close();
    }
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

function emit(text: string, out: string | undefined): void {
  if (out) {
    writeFileSync(out, text);
    process.stderr.write(`→ ${out}\n`);
  } else {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  },
);
