# Plano de implementação: v0.8.0 "AI-ready"

Posicionamento: **the stealth browser for AI agents — local, free, bring-your-own-LLM.**
Base: o relatório de pesquisa de mercado (`browser-scraper-ia-relatorio.md`).

## Decisão de licença: MIT

| Opção | Por que sim | Por que não |
|---|---|---|
| **MIT** ✅ | É o padrão do ecossistema npm (Puppeteer é Apache, Playwright é Apache e todas as libs de scraping de referência são MIT ou Apache). Não gera atrito em empresa, listas awesome, r/webscraping, Socket ou GitHub ("NOASSERTION" some). Tem o menor texto e é a mais reconhecida | Não traz cláusula de patente |
| Apache-2.0 | Tem concessão de patente | É mais verbosa. Num projeto de uma pessoa, a cláusula de patente quase não pesa |
| AGPL + comercial | Monetiza | Afasta exatamente o público que gera tração |
| PolyForm-NC (atual) | Protege o uso comercial | Na prática bloqueia a adoção, e por isso a lib está com ~0 downloads |

Observação: as versões ≤ 0.7.0 já publicadas continuam sob PolyForm-NC. A MIT vale a partir da 0.8.0.

## Escopo da v0.8.0

### Fundação
- [x] LICENSE MIT e `license` no package.json
- [x] `description` e `keywords` reposicionadas, sem nomes de vendors
- [x] `better-sqlite3` passa a ser opcional. O carregamento é lazy, usando `node:sqlite` nativo (Node ≥ 22.5) com fallback para better-sqlite3. Motivo: ele falha no build com Node 24 no Windows, então a instalação quebrava
- [x] Import ESM funcionando (`import { Browser } from ...`), com teste. O CJS continua sendo o build, porque o Node faz interop nativo e isso evita o dual-package hazard
- [x] Testes com `node:test` + tsx (unit) e e2e com Chrome real
- [x] CI no GitHub Actions (typecheck, unit e e2e) e release com Trusted Publishing + provenance
- [x] CHANGELOG.md e CONTRIBUTING.md

### Features "AI-ready", sem LLM
- [x] `tab.markdown({ mainContent, includeIframes, shortenUrls, query })`: converte HTML→Markdown a partir da árvore CDP `DOM.getDocument({pierce:true})`, sem JS na página. Inclui o conteúdo de **closed shadow roots** e **iframes cross-origin**
- [x] `tab.metadata()`: title, description, canonical, lang, OpenGraph, Twitter e JSON-LD
- [x] `htmlToMarkdown(html)` / `extractMetadata(html)` standalone, para o tier HTTP
- [x] `scrape({ url, formats, strategy: "auto" | "http" | "browser" | "stealth" })`: escalonamento HTTP → browser → stealth (Turnstile), reportando o `tier` usado
- [x] `tab.snapshot()`: snapshot da accessibility tree com refs (`[ref=e12]`), que atravessa closed shadow DOM e OOPIF. `tab.byRef(ref)` devolve um `Element` real, com o input humano da lib

### Agentes
- [x] CLI `browser-scraper` (bin): `scrape <url>`, `markdown <url>`, `snapshot <url>`, `mcp`
- [x] MCP server stdio sem dependências (JSON-RPC 2.0), com as tools navigate, snapshot, click, type, press_key, markdown, metadata, screenshot, extract_links, solve_turnstile, scrape e check_egress
- [x] Proteções do MCP: `--allowed-domains`, secrets como placeholders (`--secrets .env`, o modelo vê `{{NAME}}` e nunca o valor) e conteúdo da página delimitado como dado não confiável
- [x] `server.json` para o MCP Registry oficial, mais `mcpName`
- [x] `skills/browser-scraper/SKILL.md` para Claude Code e Codex

### Subpath `/ai` (BYO-LLM, peer deps opcionais)
- [x] `extract({ tab | markdown, schema, model | llm })`: extração estruturada. Aceita schema Zod ou JSON Schema e model do Vercel AI SDK (`ai` como peer dependency opcional) ou uma função `llm` própria
- [x] `generateExtractor()`: o LLM gera os seletores CSS **uma vez**. O `Extractor` roda sem LLM (`run`), valida, e tem `runOrHeal()`, que faz fallback para o LLM e se regenera (self-healing). Pode ser salvo e carregado como JSON
- [x] `observe({ tab, instruction })`: localiza elementos por linguagem natural sobre o snapshot e devolve `Element` reais. Sem agente autônomo

### Fora de escopo (de propósito)
Search na web, crawl/fila próprios (use o Crawlee), agente autônomo (o agente externo dirige via MCP), monitor com diff, PDF e browser em cloud.

### Fica para depois (v0.9+)
Cache de `observe` por URL, scroll infinito, seletores adaptativos sem LLM, site de docs com `llms.txt`, nome sem scope.

## Ações manuais do dono (eu não faço)
1. Revisar e fazer o merge da branch `feat/ai-agents`, e publicar com `npm publish` (ou via tag `v0.8.0` depois de configurar o Trusted Publisher)
2. No npmjs.com → package → Settings → Trusted Publisher: GitHub Actions, repo `eurafaeldecarvalho/browser-scraper`, workflow `release.yml`
3. Publicar no MCP Registry (`mcp-publisher publish`), Glama e mcp.so
4. Abrir PRs em `lorien/awesome-web-scraping` e `awesome-puppeteer`, escrever os artigos e fazer o Show HN

## Status da implementação (2026-10-17)

Tudo do escopo da v0.8.0 foi implementado na branch `feat/ai-agents`.

**Verificado:**
- `pnpm check` passa.
- 16 testes unitários.
- 6 testes e2e com Chrome real. A fixture tem closed shadow root, um iframe cross-origin (OOPIF), uma SPA e uma página de desafio.
- Import ESM e CJS do `dist`, inclusive o `/ai`.
- `npm pack` gera 129 kB.
- Em sites reais: books.toscrape.com e Hacker News (markdown).

**Não verificado / limitações conhecidas:**
- **LLM real:** `extract`, `generateExtractor` e `observe` só foram testados com mock do AI SDK e com uma função `llm` falsa. Falta rodar com uma chave real (`pnpm example:ai`).
- **Turnstile no nowsecure.nl:** o widget é encontrado e clicado no lugar certo (dentro do shadow DOM do OOPIF), mas não aprova, nem headful nem headless. É comportamento do núcleo stealth que já existia (`solveTurnstile`), fora do escopo desta release, e precisa de investigação separada. `scrape()` reporta corretamente como bloqueado.
- **CI do GitHub Actions** escrita, mas ainda não executada, porque nada foi enviado para o GitHub.

**Bugs que já existiam e foram corrigidos de quebra:**
- `goto()`/`waitForNavigation()` deixavam um timer de 30 s vivo, e o processo demorava ~30 s para sair depois do `close()`.
- No Windows, `close()` não matava a árvore de processos do Chrome.
- O offset de iframe usava o do primeiro iframe da página, não o do iframe alvo.
- O `better-sqlite3` quebrava a instalação no Node 24 / Windows.
