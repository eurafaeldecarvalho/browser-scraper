# Como funcionam reCAPTCHA v3/Enterprise e os sistemas anti-bot (pesquisa 2025/2026)

> Base de conhecimento sobre detecção de bots, para fundamentar as decisões de stealth desta lib.
> Produzido por pesquisa web multi-fonte (2025/2026) com **verificação adversarial** de cada afirmação
> de maior peso. Não confunda com a auditoria da lib / decisão de chromium-no-Lambda (essas são
> específicas do projeto). As notas brutas por vendor estão em [`.firecrawl/`](../.firecrawl/).

## Legenda de confiança

Anti-bot é um domínio onde 90% do que circula é folclore de fornecedor de bypass. Este doc marca:

- **[CONFIRMADO]** — corroborado por ≥2 fontes independentes (de preferência fonte primária: docs oficiais, Gerrit, RFC).
- **[PARCIAL]** — o núcleo é real, mas alguma parte da formulação comum é mais forte que a evidência.
- **[INFERÊNCIA]** — raciocínio plausível e acionável, mas **não documentado** — não tratar como fato.
- **[FOLCLORE]** — números/detalhes de fonte única (geralmente vendor de solver); volátil; **não hard-codar**.

> **A frase-âncora:** em quase todo anti-bot moderno os sinais são **cumulativos e multiplicativos**, e
> a camada **pré-JS (IP/ASN + TLS/HTTP2)** é a de maior peso. Um fingerprint perfeito **não** compensa um
> ASN de datacenter. A alavanca #1 é quase sempre **a rede (IP residencial), não o binário**.

---

## 1. Taxonomia das camadas de sinal (ranqueada por impacto)

Da mais para a menos load-bearing num cenário típico (reCAPTCHA v3 + anti-bot comportamental):

| # | Camada | Quem decide | Notas |
|---|--------|-------------|-------|
| 1 | **Rede / IP-ASN** | reputação do exit IP | Datacenter/cloud penalizado **antes** do JS; interage multiplicativamente. |
| 2 | **TLS (JA3/JA4) + HTTP/2 fingerprint** | a engine do browser | Chrome real over CDP = nativo (força); JA4+ é o gold standard 2026. |
| 3 | **Render-hash (canvas/WebGL, ex.: Picasso)** | GPU/render real | SwiftShader = cluster "sem-GPU". Não falseável só por string. |
| 4 | **Provenance de input (`isTrusted` + geometria/timing)** | como o input é gerado | `isTrusted=true` é necessário mas **não suficiente**. |
| 5 | **Tells de JS-environment (headless)** | o binário/modo | `navigator.webdriver`, `window.chrome`, plugins, `connection.rtt`, UA. |
| 6 | **Protocolo de automação (CDP)** | o driver | `Runtime.enable`, `Target.setAutoAttach`, porta debug. |
| 7 | **Reputação de cookie/conta** | histórico server-side | Não falseável estaticamente; só aquecível. |

---

## 2. reCAPTCHA v3 / Enterprise

### 2.1 Modelo de score (não é um gate)

reCAPTCHA v3/Enterprise é um motor de **probabilidade contínua** `0.0` (bot) → `1.0` (humano), não um
quebra-cabeça. O token só vale se o **score que ele carrega** passar o threshold **server-side** do site:

- v3 clássico: `siteverify`.
- Enterprise: `projects.assessments.create` (`createAssessment`).
- **Sem billing** o site só vê 4 buckets (`0.1 / 0.3 / 0.7 / 0.9`); **com billing**, 11 níveis.
- Política comum: allow ≥ 0.7; fricção 0.3–0.7; deny < 0.3 (threshold default recomendado pelo Google = 0.5).

### 2.2 O que decide o score

Em ordem de peso (para um cenário de scraping em datacenter/Lambda):

1. **[PARCIAL] Reputação de IP/ASN + estado de cookie/conta Google = sinais dominante-tier.**
   Datacenter (AWS/DO/Hetzner) tem baixa confiança inerente e tende a score baixo; residencial/móvel,
   alto. *Calibração honesta:* a versão forte — "o IP **trava** o score **antes** do JS terminar,
   **independente** do fingerprint" — é **mais forte que a evidência**. O Google não publica pesos nem
   timing; a telemetria comportamental é coletada no/após o load; o token vale ~2min. Vendors (2captcha,
   CaptchaAI, capmonster, DataDome) descrevem **camadas complementares cumulativas** (IP + TLS/fingerprint
   + comportamento + cookies/conta + `action` correto), e um experimento controlado (cleantalk) viu um bot
   Python em datacenter receber **0.9 constante** (atribuído a site com pouco tráfego → modelo ML não
   treinado, default ~0.9, buckets). **Conclusão estratégica válida:** priorizar proxy residencial +
   token casado por IP sobre fingerprint-perfeito; **mas** descreva o mecanismo como "IP/cookie são
   dominante-tier", não como determinante pré-JS que sobrepõe tudo.
2. **Cookies / conta Google.** `_GRECAPTCHA` + sessão `NID`/`SID` logada é prior positivo forte.
   **[FOLCLORE]** as bandas exatas (fresh ~0.3–0.5, warmed ~0.5–0.7; `SID` +0.1–0.3, `NID` +0.05–0.1)
   são **estimativas de vendor (CaptchaAI)**, não números do Google — tratar como folclore e **A/B-medir**
   o `createAssessment` real antes de investir em login-por-persona.
3. **Comportamento.** mouse path, scroll, cadência de teclas, `userActivation`, timestamp da 1ª interação.
   Chamar `grecaptcha.execute()` logo após o load, sem atividade prévia, parece robótico → tanca a ~0.1–0.3.
4. **Coerência de ambiente.** UA × Client-Hints × platform × WebGL; `navigator.webdriver`; UA `HeadlessChrome`.

### 2.3 Ciclo de vida do token

- TTL **~120s** (documentado), **uso único** (`timeout-or-duplicate` em replay).
- O backend **deve** checar `action` == esperado e `hostname`.
- Mint **no momento da ação protegida**, nunca no load.

### 2.4 A VM cliente (BotGuard / WAA)

**[CONFIRMADO]** reCAPTCHA roda uma **VM de bytecode JS fortemente ofuscada** (descrita como tendo "512
registers... designed to resist reverse engineering"), com **integrity-tags via `Symbol(jas)`**
(Symbol não-enumerável em arrays/objetos, perdido no clone → detecção de adulteração) e HMAC-SHA256.
Coleta as **categorias**: `navigator.webdriver`, WebGL renderer/vendor, fontes, screen, timezone, plugins,
sinais comportamentais e um valor `rc::a` em localStorage.

**[FOLCLORE — NÃO hard-codar]** os **índices de slot exatos** que circulam (`545`=webdriver, `~1310`=WebGL,
`4`=`rc::a` HMAC, "35+ slots") vêm de **um único repo** (`elyelysiox/recaptcha`), não são corroborados,
e são explicitamente **voláteis** (polimorfismo/rotação de opcode por versão; o próprio repo registra
"BotGuard removed 04/01/2026"). São snapshots de **uma** build, não endereços estáveis.

### 2.5 Solvers — eficácia real

**[CONFIRMADO]** Para v3 score-based, solvers **não garantem** o resultado: o score é decidido server-side
por sinais que o token não carrega.

- **~0.10** uniforme medido para tokens **proxyless/datacenter** (benchmark independente jan/2026).
- **~0.3** central com IP não-residencial (estimativa CaptchaAI).
- **0.7–0.9** anunciado **só** é atingível com **proxy residencial de qualidade cujo IP casa com a request**
  + task type **Enterprise**.
- **Operacional:** se usar solver, alimente **SEU** proxy no `ReCaptchaV3EnterpriseTask` (nunca a variante
  proxyless), case `pageAction`, respeite o TTL. Para uma ação gated em 0.7, um solver sem rede residencial
  casada é **teatro**.

---

## 3. Camada de rede (pré-JS) — o que uma lib em Node **não** conserta em JS

### 3.1 IP / ASN
A alavanca #1. Roteie o egress por **proxy residencial/móvel**, um **exit distinto por run**, geo-casado.
Concentrar exits no fan-out aciona os `reasons` Enterprise `TOO_MUCH_TRAFFIC` / `UNEXPECTED_USAGE_PATTERNS`.

### 3.2 TLS — JA3 / JA4 / JA4+
Emitido pelo BoringSSL/`//net` do Chromium real. **Dirigir Chrome/Chromium real over CDP é uma força**:
o ClientHello é genuíno e o JA4+ (gold standard 2026) **falha contra engine de browser real**.
`chrome-headless-shell` compartilha o mesmo net stack do Chrome full → idêntico. **Não mexer no wire-shape.**
*Caveat:* o fingerprint **end-to-end** depende do path proxy/NAT — verifique se o proxy residencial
**termina+re-origina TCP** (CONNECT) ou vaza o stack do NAT/Lambda, e se o NAT/proxy **não** reordena/altera
headers nem os SETTINGS H2.

### 3.3 HTTP/2 (fingerprint da Akamai)
**[CONFIRMADO]** o fingerprint H2 do Chrome moderno (≈ Chrome 124–144) é, no formato Akamai:

```
SETTINGS  1:65536;2:0;4:6291456;6:262144   (HEADER_TABLE_SIZE; ENABLE_PUSH=0; INITIAL_WINDOW_SIZE=6MB; MAX_HEADER_LIST_SIZE=256KB)
WINDOW_UPDATE 15663105                       (~15MB)
PRIORITY  0                                  (Chrome moderno não manda PRIORITY frames separados)
pseudo-header order  m,a,s,p                  (:method,:authority,:scheme,:path)
```

Chrome **omite** os SETTINGS IDs `3` (MAX_CONCURRENT_STREAMS) e `5` (MAX_FRAME_SIZE). É **version-specific**
(Chrome 101 incluía o ID 3); re-confirmar contra a build real em uso. Como a lib dirige Chromium real, esse
fingerprint vem de graça — desde que nada no caminho (proxy/NAT/HTTP-client) o reescreva.

---

## 4. Fingerprint de browser / headless / CDP

### 4.1 `Runtime.enable` e o probe do `Error.stack`
**[PARCIAL]** Historicamente, o melhor probe de CDP: com o domínio Runtime habilitado, `console.log` de um
`Error` fazia o Chrome serializá-lo para o inspector e **ler o getter `.stack`**, flipando um flag de detecção;
evitar `Runtime.enable` derrotava isso. **Mai/2025** o V8 mergeou dois patches (Gerrit CL **6506243**, merged
2025-05-07, e **6513972**, merged 2025-05-09, em ~Chrome 137) que pararam de rodar getters de usuário durante
o preview do inspector → **degradaram fortemente** esse sub-sinal. **Porém:** (a) o patch é **incompleto** —
um pesquisador independente (svebaa.github.io, mar/2026) verificou um caminho residual ("Path B") explorável
em Chrome pós-patch; (b) evitar `Runtime.enable` **ainda derrota** os outros sinais do domínio Runtime (ex.:
`Runtime.consoleAPICalled`). **Veredito para a lib:** evitar `Runtime.enable` continua um **invariante correto**,
só não é mais "o" tell dominante — não o apresente como a defesa primária.

> **[INFERÊNCIA]** Um leak de Proxy na cadeia de protótipos (`ownKeys` trap disparado pelo console-preview
> com Runtime habilitado) é reportado como **não-patchado em mar/2026**, mas é **fonte única** (svebaa) — re-checar
> antes de confiar. Não há evidência de que a Kasada use exatamente esse probe.

### 4.2 Os três modos: shell vs new-headless vs headful
- **`chrome-headless-shell`** (o que o `@sparticuz/chromium` entrega) = o headless "shell" antigo: UA com
  `HeadlessChrome`, **sem `window.chrome`/`chrome.runtime`**, `navigator.plugins` vazio, `connection.rtt=0`,
  sem GPU. Mais detectável.
- **`--headless=new`** = browser completo em modo headless (UA sem Headless, `window.chrome` real, plugins,
  codecs). Existe **só no binário Chrome/Chromium full**.
- **headful** = o mais indistinguível.
- **Insight crucial:** os **dois piores tells num host sem GPU (WebGL SwiftShader, sem GPU) são IDÊNTICOS**
  entre shell e new-headless — vêm do **host sem GPU**, não do modo headless. A camada de rede (TLS/H2) também
  é idêntica. Logo, trocar shell→new-headless fecha só os tells de **JS-environment**, que são **baratos de
  injetar em JS**.

### 4.3 WebGL / SwiftShader / render-hash (Picasso)
**[REFUTADO]** "spoofar a string do renderer é suficiente". Cloudflare/Turnstile/DataDome coletam a string
**E** o **hash de pixels** do canvas/WebGL renderizado e cruzam por coerência: uma string alegando GPU real
enquanto o host renderiza via SwiftShader produz um **hash incoerente** que flaga a sessão. Além disso, o
**override em JS é detectável** (`getParameter.toString()`, configurability do descriptor, mutação de protótipo).
Para fechar de verdade só com: GPU real, engine de fingerprint que injeta um render casado, ou **patch no
código-fonte do Chromium** — não um shim JS.

**[PARCIAL]** Desde ~Chrome 130 (warning) / ~M137–139 (default), **o fallback automático para SwiftShader foi
removido**: sem `--enable-unsafe-swiftshader` a criação de contexto WebGL **falha** (também um tell). O
`@sparticuz/chromium` (v149, `graphicsMode=true` default) **já passa** `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader` → no Lambda **tem** WebGL software (SwANGLE) e expõe um render-hash SwiftShader
que o Picasso pode flagrar (não é "sem WebGL"). **Regra:** spoof de WebGL só para soft-targets; contra
render-hash, honesto > spoof.

### 4.4 `screenX == clientX` (bug CDP 40280325)
**[PARCIAL]** `Input.dispatchMouseEvent` (CDP) historicamente produz eventos cujo `screenX/screenY` é forçado
**igual** a `clientX/clientY` (alias `.x/.y`), em vez das coordenadas globais reais — Chromium bug **40280325**.
Como os eventos CDP são `isTrusted=true`, essa anomalia é um **sinal independente** que o mandato de
`isTrusted` **não remove**, e praticantes reportam que o **Turnstile** o lê. **Caveat de estado atual:** é um
bug **dependente de versão** — há fix do Google de ~set/2025 que pode já estar mergeado no 149/headless-shell.
**Verificar empiricamente** na sua build antes de aplicar offset (corrigir um valor já-correto vira **novo**
tell). Lado da detecção = practitioner-reported, não confirmado por vendor; para a securiti.ai é **inferência**.

### 4.5 Canvas / Audio / Fontes / WebGPU / Workers
- **Canvas/Audio/Fontes:** coletados como fingerprint. Em geral **deixar nativo** (honesto > patch) — patch
  inconsistente é pior.
- **WebGPU (`navigator.gpu`):** **[INFERÊNCIA]** sob UA desktop no shell, `navigator.gpu` pode existir enquanto
  `requestAdapter()` retorna `null` (sem GPU) → incoerência string-vs-capability paralela à do WebGL. Verificar
  e decidir delete-vs-leave.
- **Workers:** overrides main-world (webgl, screen, webdriver via `defineProperty`) **não propagam** a Web
  Workers; CreepJS lê `WorkerNavigator`. `navigator.hardwareConcurrency` via `Emulation.setHardwareConcurrencyOverride`
  (engine-level) propaga; `deviceMemory` **não** tem override CDP → **não** falsear (criaria mismatch worker/main).

### 4.6 Suítes de teste que os vendors espelham
`bot-detector.rebrowser.net`, CreepJS, `bot.sannysoft.com`, `browserscan.net`, `pixelscan`, `iphey`. Medir
**no binário de produção real** (ex.: `chrome-headless-shell` do sparticuz no Lambda), não em Chrome local
headful — as superfícies diferem.

---

## 5. Vendors anti-bot (deep dives)

### 5.1 Cloudflare — Turnstile + Bot Management
Turnstile (managed / non-interactive / invisible), Bot Management / Bot Fight Mode, o JS challenge
("Just a moment...") e o Managed Challenge. Sinais: **JA4 Signals**, fingerprint HTTP/2, bot score 1–99,
cookie `cf_clearance`, threat-intel global de IP. **Lê o bug `screenX==clientX` mesmo com `isTrusted=true`**
e **cruza a string do WebGL com o hash de pixels** renderizados (>30 sinais: WebGL renderer, canvas hash,
audio context, fontes).

### 5.2 DataDome — incl. Picasso
JS tag/sensor + cookie `datadome`. **Picasso** = render-hash canvas/WebGL semeado que **força um render real**
e clusteriza contra browser+OS+GPU; SwiftShader cai num cluster determinístico "sem-GPU/headless". Spoof de
`getParameter` **não toca os pixels** → inútil e pior (cria inconsistência string-vs-hash). Notas brutas:
[`.firecrawl/dd-cdp.md`](../.firecrawl/dd-cdp.md), [`.firecrawl/dd-picasso.md`](../.firecrawl/dd-picasso.md).

### 5.3 PerimeterX / HUMAN
Sensor JS, cookies `_px`/`_pxhd`/`_pxvid`, challenge press-and-hold. Lê fingerprints de WebGL/Canvas/Audio/WebRTC
+ comportamento + CDP/headless. **[INFERÊNCIA]** não há evidência independente de que a PX pondere
especificamente um mismatch "IP residencial × renderer software" como sinal de bloqueio (é prática geral, não
comportamento medido da PX). Notas brutas: [`.firecrawl/px.md`](../.firecrawl/px.md).

### 5.4 Kasada
**[CONFIRMADO]** bootstrap via `429 → /ips.js?timestamp=... → POST /tl`. Headers: **`x-kpsdk-cd`** =
proof-of-work **regenerado a cada request**; **`x-kpsdk-ct`** = token de sessão reusado (com TTL finito,
~30min em alguns deploys, tão curto quanto 60–180s em deploys agressivos → cache-and-refresh, não reuso
indefinido). VM de bytecode ofuscada + PoW. Considerada uma das mais difíceis. Notas: [`.firecrawl/kasada.md`](../.firecrawl/kasada.md).

### 5.5 Akamai Bot Manager
Cookies `_abck` e `bm_sz`, telemetria `sensor_data`, pixel challenge. **[CONFIRMADO]** o fingerprint HTTP/2
(a Akamai criou o formato no BlackHat EU 2017). **[PARCIAL]** `_abck` tem layout `~timestamp~status~hash~`;
validação é **multi-post** (comumente 1–3, às vezes mais, **dependente de config**); marcadores `~-1~`/`~0~`
indicam sessão não-validada/burned; um cookie terminando em **`~0~-1~-1`** indica invalidação (tipicamente
após ação protegida) e re-valida com **1 sensor POST** adicional; o "stop signal" client-side é exposto nos
SDKs de RE como `IsCookieValid(cookie, requestCount)`, mas **nem todo site o ativa**. Tudo isso vem de RE/SDKs
de bypass (Hyper Solutions, FRIS-Solutions), não de docs da Akamai; varia por config/versão (v2/v3).

### 5.6 Imperva / Incapsula
Token `___utmvc` / `reese84`, sensor ofuscado, fluxo de challenge. Cruza o ambiente JS-declarado contra o
TLS/H2 ao vivo. (Mesmas primitivas das demais.)

### 5.7 securiti.ai *(alvo real nos sites de seguradora BR)*
Camada **independente** do reCAPTCHA: forms com reCAPTCHA + script comportamental/honeypot client-side. **[INFERÊNCIA]**
plausível que leia `isTrusted`/coordenadas — **não confirmado em docs**. Prático: **não auto-preencher honeypots**;
só interagir com inputs visíveis; timing humano de preenchimento; input CDP-trusted.

### 5.8 Arkose Labs / FunCaptcha
Challenge interativo (puzzles) + telemetria. Lê `video_codecs`/capacidades de mídia (onde o headless-shell sem
codecs proprietários se destaca) + comportamento + ambiente.

### 5.9 hCaptcha
Modelo score/challenge análogo; sinais de fingerprint + comportamento; pode escalar para puzzle visual.

---

## 6. Implicações para uma lib de automação stealth (checklist)

**Fazer:**
- Dirigir **Chrome/Chromium real over CDP** (TLS/H2 nativos) e **não** mexer no wire-shape de headers.
- **Evitar `Runtime.enable`** (invariante correto, mesmo que o sub-sinal do stack-getter tenha degradado).
- **Input via CDP** (`isTrusted=true`) com geometria/timing **humanos** (Bézier/min-jerk, dwell/flight lognormal,
  overshoot, ocasional typo+correção), e **atividade ambiente antes** de `grecaptcha.execute`/submit.
- **Persona coerente** derivada de UMA UA (UA × CH × platform × WebGL × geo), com **GREASE lido do browser vivo**.
- Sob headless-shell: shimar **só** o que o shell genuinamente perde (`window.chrome`, `connection.rtt`), de
  forma **condicional** (no-op se já correto).
- **Verificar que o contexto WebGL existe** antes de instalar qualquer override de `getParameter`.
- Injetar cookies aquecidos **via CDP `Network.setCookie`** (criptografado com a chave viva), nunca por arquivo
  SQLite (Chrome ≥80 ignora `value` plaintext, lê `encrypted_value`).
- **Medir** nas suítes (rebrowser/sannysoft/CreepJS) **no binário de produção**.

**Não fazer:**
- **Não** spoofar string de WebGL contra render-hash (Picasso/Turnstile) — pior que honesto.
- **Não** falsear `deviceMemory` (mismatch worker/main).
- **Não** forjar `_GRECAPTCHA`/`SID`/`HSID` (mintados/validados server-side; só adicionam superfície de inconsistência).
- **Não** hard-codar slots da VM do reCAPTCHA nem o post-count do `_abck` (voláteis/config-dependentes).
- **Não** apostar que solver entrega 0.7+ sem rede residencial casada.
- **Não** aplicar o offset de `screenX` sem verificar que o bug existe na build.

---

## Apêndice A — Afirmações verificadas adversarialmente (resumo)

| Veredito | Afirmação |
|----------|-----------|
| PARCIAL | IP/cookie decidem o score "antes do JS, independente do fingerprint" → na verdade **dominante-tier**, cumulativo. |
| PARCIAL | Slots internos da VM do reCAPTCHA (545=webdriver etc.) → **fonte única, voláteis**; categorias OK, índices não. |
| CONFIRMADO | Tokens de solver off-the-shelf falham em 0.7+ (score real ~0.1–0.3 sem proxy residencial casado). |
| CONFIRMADO | Bandas de score por cookie são estimativas de vendor, **não** números do Google. |
| PARCIAL | `screenX==clientX` no CDP + Turnstile detecta apesar do `isTrusted` → **verdadeiro, mas version-dependent** (fix ~set/2025; verificar). |
| REFUTADO | Spoofar string do renderer WebGL "neutraliza" o Turnstile → **falso** (cruza com hash de pixels; override detectável). |
| PARCIAL | Chrome moderno não cai mais em SwiftShader automático → verdade, **mas** o sparticuz força os flags e **tem** WebGL software. |
| PARCIAL | Patches V8 mai/2025 "neutralizaram" o tell do Runtime.enable → degradaram, mas **incompletos**; outros sinais Runtime sobrevivem. |
| CONFIRMADO | Kasada: `x-kpsdk-cd` (PoW por request) vs `x-kpsdk-ct` (sessão); bootstrap `429→/ips.js→POST /tl`. |
| PARCIAL | `_abck` da Akamai: multi-post, `~0~-1~-1` = invalidado, `IsCookieValid` stop-signal → real, mas config-dependente. |
| CONFIRMADO | Fingerprint HTTP/2 do Chrome: `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` (omite IDs 3 e 5). |

## Apêndice B — Fontes primárias principais

- reCAPTCHA v3 (oficial): https://developers.google.com/recaptcha/docs/v3
- Enterprise `createAssessment`: https://docs.cloud.google.com/recaptcha/docs/interpret-assessment-website
- V8 CDP patches (Gerrit, primária): CL 6506243 / CL 6513972 (mai/2025)
- CDP screenX bug: https://issues.chromium.org/issues/40280325
- SwiftShader (Chromium docs): https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/swiftshader.md
- HTTP/2 fingerprint: https://scrapfly.io/blog/posts/http2-http3-fingerprinting-guide
- CDP fingerprinting (independente): https://svebaa.github.io/personal/blog/cdp-fingerprinting/
- Akamai `_abck` (RE): https://github.com/Edioff/akamai-analysis
- WebGL renderer em fingerprinting: https://blog.castle.io/the-role-of-webgl-renderer-in-browser-fingerprinting/

> **Metodologia:** 11 pesquisas web profundas → 14 afirmações verificadas adversarialmente contra ≥2 fontes
> independentes → crítica de completude. As notas brutas por vendor (PerimeterX, DataDome CDP/Picasso, Kasada)
> estão em [`.firecrawl/`](../.firecrawl/). Anti-bot é cat-and-mouse: re-validar contra a build/alvo reais.
