import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Keyboard } from "../behavior/keyboard";
import { getSharedMouse, HumanMouse } from "../behavior/mouse";
import { CDPClient, CDPError } from "./cdp-client";
import { Element } from "./element";
import { Network } from "./network";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export type WaitForSelectorState = "attached" | "visible" | "hidden" | "ready";

type ProtocolLifecycleEvent = "load" | "DOMContentLoaded" | "networkIdle" | "networkAlmostIdle";

const WAIT_UNTIL_TO_PROTOCOL_EVENT: Record<WaitUntil, ProtocolLifecycleEvent> = {
  load: "load",
  domcontentloaded: "DOMContentLoaded",
  networkidle0: "networkIdle",
  networkidle2: "networkAlmostIdle",
};

export class Tab {
  ws_url: string;
  target_info: Record<string, any>;
  target_id: string;

  private _cdp: CDPClient;
  private _frame_id: string | null = null;
  private _execution_context_id: number | null = null;
  private _oop_frame_sessions = new Map<string, string>();
  private _network: Network | null = null;
  private _proxy_auth: [string, string] | null;
  private _user_agent: string | null;
  private _webgl: { vendor: string | null; renderer: string | null };

  constructor(
    ws_url: string,
    target_info: Record<string, any>,
    proxy_auth: [string, string] | null = null,
    user_agent: string | null = null,
    webgl: { vendor: string | null; renderer: string | null } = { vendor: null, renderer: null },
  ) {
    this.ws_url = ws_url;
    this.target_info = target_info;
    this.target_id = String(target_info.id ?? "");
    this._cdp = new CDPClient(ws_url);
    this._proxy_auth = proxy_auth;
    this._user_agent = user_agent;
    this._webgl = webgl;
  }

  async connect(): Promise<void> {
    await this._cdp.connect();
    await this._cdp.send("Page.enable");
    await this._cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this._cdp.send("DOM.enable");
    await this._cdp.send("Network.enable");
    // NOTE: Runtime.enable is intentionally NOT called. Anti-bot vendors
    // (Cloudflare, DataDome, Kasada) detect its use as an automation signal.
    // All JS runs through Page.createIsolatedWorld + Runtime.evaluate(contextId),
    // which are plain commands that do not require the Runtime domain to be
    // enabled. Context invalidation is handled via Page.frameNavigated and
    // stale-context-error retries instead of Runtime.executionContext* events.

    this._cdp.on("Page.frameNavigated", (params) => {
      this._on_frame_navigated(params as Record<string, any>);
    });

    this._cdp.on("Page.frameDetached", (params) => {
      this._on_frame_detached(params as Record<string, any>);
    });

    await this._apply_user_agent_override();
    await this._apply_webgl_override();

    if (this._proxy_auth) {
      await this._cdp.send("Fetch.enable", {
        handleAuthRequests: true,
      });

      const proxy_auth = this._proxy_auth;
      const cdp = this._cdp;

      this._cdp.on("Fetch.authRequired", (params) => {
        void (async () => {
          const auth_challenge = params.authChallenge as Record<string, any> | undefined;
          try {
            if (auth_challenge?.source === "Proxy") {
              const [username, password] = proxy_auth;
              await cdp.send("Fetch.continueWithAuth", {
                requestId: params.requestId,
                authChallengeResponse: {
                  response: "ProvideCredentials",
                  username,
                  password,
                },
              });
              return;
            }

            await cdp.send("Fetch.continueWithAuth", {
              requestId: params.requestId,
              authChallengeResponse: {
                response: "CancelAuth",
              },
            });
          } catch {
          }
        })();
      });

      this._cdp.on("Fetch.requestPaused", (params) => {
        void cdp.send("Fetch.continueRequest", {
          requestId: params.requestId,
        }).catch(() => undefined);
      });
    }

    try {
      await this._cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      this._cdp.on("Target.attachedToTarget", (params) => {
        this._on_frame_attached(params as Record<string, any>);
      });
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }

    await this._refresh_main_frame_id();
  }

  async close(): Promise<void> {
    await this._cdp.disconnect();
  }

  private _on_frame_attached(params: Record<string, any>): void {
    const target_info = (params.targetInfo ?? {}) as Record<string, any>;
    const session_id = typeof params.sessionId === "string" ? params.sessionId : null;
    const target_id = typeof target_info.targetId === "string" ? target_info.targetId : null;
    const target_type = typeof target_info.type === "string" ? target_info.type : null;

    if (target_type === "iframe" && session_id && target_id) {
      this._oop_frame_sessions.set(target_id, session_id);
      void this._init_oop_frame(session_id);
    }
  }

  private async _init_oop_frame(session_id: string): Promise<void> {
    try {
      await this._cdp.send("DOM.enable", {}, session_id);
      await this._cdp.send("Runtime.runIfWaitingForDebugger", {}, session_id);
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }
  }

  private _invalidate_execution_context(): void {
    this._execution_context_id = null;
  }

  // Applies a cleaned User-Agent together with matching client-hint metadata.
  // Overriding the UA string alone leaves sec-ch-ua headers reporting
  // "HeadlessChrome"; supplying userAgentMetadata keeps both in sync.
  private async _apply_user_agent_override(): Promise<void> {
    if (!this._user_agent) {
      return;
    }

    try {
      await this._cdp.send("Network.setUserAgentOverride", {
        userAgent: this._user_agent,
        userAgentMetadata: build_user_agent_metadata(this._user_agent),
      });
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }
  }

  // Spoofs the WebGL UNMASKED vendor/renderer reported to the page. Critical on
  // GPU-less cloud hosts, where Chrome falls back to SwiftShader/llvmpipe — a
  // strong headless/server tell. The Proxy preserves getParameter.toString() so
  // the override doesn't itself read as a patched ("lying") function.
  private async _apply_webgl_override(): Promise<void> {
    const { vendor, renderer } = this._webgl;
    if (!vendor || !renderer) {
      return;
    }

    const source = build_webgl_override_source(vendor, renderer);
    try {
      await this.addInitScript({ source });
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }
  }

  // Sets the WebGL identity for subsequent navigations in this tab.
  async spoofWebGL({ vendor, renderer }: { vendor: string; renderer: string }): Promise<void> {
    this._webgl = { vendor, renderer };
    await this.addInitScript({ source: build_webgl_override_source(vendor, renderer) });
  }

  private async _refresh_main_frame_id(): Promise<string> {
    const frame_tree = await this._cdp.send("Page.getFrameTree");
    const frame_id = String(frame_tree.frameTree?.frame?.id ?? "");

    if (!frame_id) {
      throw new Error("Failed to resolve main frame id");
    }

    this._frame_id = frame_id;
    return frame_id;
  }

  private _on_frame_navigated(params: Record<string, any>): void {
    const frame = (params.frame ?? {}) as Record<string, any>;
    const frame_id = typeof frame.id === "string" ? frame.id : null;
    const parent_id = typeof frame.parentId === "string" ? frame.parentId : null;

    if (!frame_id || parent_id) {
      return;
    }

    this._frame_id = frame_id;
    this._invalidate_execution_context();
  }

  private _on_frame_detached(params: Record<string, any>): void {
    const frame_id = typeof params.frameId === "string" ? params.frameId : null;

    if (!frame_id || frame_id !== this._frame_id) {
      return;
    }

    this._frame_id = null;
    this._invalidate_execution_context();
  }

  private _is_stale_execution_context_error(error: unknown): boolean {
    if (!(error instanceof CDPError)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("cannot find context with specified id")
      || message.includes("execution context was destroyed")
      || message.includes("inspected target navigated or closed")
      || message.includes("cannot find default execution context")
    );
  }

  private _is_stale_frame_error(error: unknown): boolean {
    if (!(error instanceof CDPError)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes("no frame with given id") || message.includes("cannot find frame with given id");
  }

  private async _ensure_execution_context(): Promise<number> {
    if (this._execution_context_id) {
      return this._execution_context_id;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const frame_id = this._frame_id ?? (await this._refresh_main_frame_id());

      try {
        const result = await this._cdp.send("Page.createIsolatedWorld", {
          frameId: frame_id,
          worldName: "util",
        });

        const execution_context_id = Number(result.executionContextId ?? 0);
        if (!execution_context_id) {
          throw new Error("Failed to create isolated execution context");
        }

        this._execution_context_id = execution_context_id;
        return execution_context_id;
      } catch (error) {
        if (attempt === 0 && this._is_stale_frame_error(error)) {
          this._frame_id = null;
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to create isolated execution context");
  }

  private _normalize_wait_until(wait_until: string): WaitUntil {
    if (wait_until in WAIT_UNTIL_TO_PROTOCOL_EVENT) {
      return wait_until as WaitUntil;
    }

    throw new Error(
      `Unknown wait_until value: ${wait_until}. Expected one of load, domcontentloaded, networkidle0, networkidle2`,
    );
  }

  async goto({
    url,
    waitUntil = "load",
    timeout = 30_000,
  }: {
    url: string;
    waitUntil?: WaitUntil;
    timeout?: number;
  }): Promise<void> {
    const normalized_wait_until = this._normalize_wait_until(waitUntil);
    this._invalidate_execution_context();

    const navigation = this.waitForNavigation({ waitUntil: normalized_wait_until, timeout });
    void navigation.catch(() => undefined);
    const result = await this._cdp.send("Page.navigate", { url });

    if (result.errorText) {
      throw new Error(`Navigation failed: ${String(result.errorText)}`);
    }

    this._frame_id = String(result.frameId ?? this._frame_id ?? "");
    await navigation;
  }

  async waitForNavigation({
    waitUntil = "load",
    timeout = 30_000,
  }: {
    waitUntil?: WaitUntil;
    timeout?: number;
  } = {}): Promise<void> {
    const normalized_wait_until = this._normalize_wait_until(waitUntil);
    const expected_event = WAIT_UNTIL_TO_PROTOCOL_EVENT[normalized_wait_until];
    const main_frame_id = this._frame_id ?? (await this._refresh_main_frame_id());

    let event_handler: ((params: Record<string, unknown>) => void) | null = null;
    const navigation_event = new Promise<void>((resolve) => {
      event_handler = (params) => {
        const frame_id = typeof params.frameId === "string" ? params.frameId : null;
        const name = typeof params.name === "string" ? params.name : null;

        if (frame_id !== main_frame_id || name !== expected_event) {
          return;
        }

        resolve();
      };
    });

    if (event_handler) {
      this._cdp.on("Page.lifecycleEvent", event_handler);
    }

    try {
      await Promise.race([
        navigation_event,
        delay(timeout).then(() => {
          throw new Error(`Timeout waiting for navigation: ${normalized_wait_until}`);
        }),
      ]);
    } finally {
      if (event_handler) {
        this._cdp.off("Page.lifecycleEvent", event_handler);
      }
    }
  }

  async reload({ timeout = 30_000 }: { timeout?: number } = {}): Promise<void> {
    this._invalidate_execution_context();
    await this._cdp.send("Page.reload");
    await this._wait_document_ready(timeout);
  }

  async back({ timeout = 30_000 }: { timeout?: number } = {}): Promise<void> {
    await this._navigate_history(-1, timeout);
  }

  async forward({ timeout = 30_000 }: { timeout?: number } = {}): Promise<void> {
    await this._navigate_history(1, timeout);
  }

  private async _navigate_history(offset: number, timeout: number): Promise<void> {
    const history = await this._cdp.send("Page.getNavigationHistory");
    const entries = (history.entries ?? []) as Array<Record<string, any>>;
    const current_index = Number(history.currentIndex ?? 0);
    const target_index = current_index + offset;

    if (target_index < 0 || target_index >= entries.length) {
      return;
    }

    const entry_id = entries[target_index]?.id;
    if (entry_id === undefined) {
      return;
    }

    const previous_url = await this._current_url_safe();
    this._invalidate_execution_context();
    await this._cdp.send("Page.navigateToHistoryEntry", { entryId: entry_id });
    // History restores (including bfcache) may not re-fire the "load" lifecycle
    // for the original frame id, so settle by polling URL + readyState instead.
    await this._wait_document_ready(timeout, previous_url);
  }

  private async _current_url_safe(): Promise<string | null> {
    try {
      return String(await this.evaluate({ expression: "location.href" }) ?? "");
    } catch {
      return null;
    }
  }

  // Waits until the document is interactive/complete and, when a previous URL is
  // given, until the URL actually changed. Frame-id and bfcache agnostic.
  private async _wait_document_ready(timeout: number, previous_url: string | null = null): Promise<void> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      try {
        const state = await this.evaluate({
          expression: "location.href + '|' + document.readyState",
        });

        if (typeof state === "string") {
          const separator = state.lastIndexOf("|");
          const url = state.slice(0, separator);
          const ready_state = state.slice(separator + 1);
          const url_changed = previous_url === null || url !== previous_url;
          if (url_changed && (ready_state === "interactive" || ready_state === "complete")) {
            return;
          }
        }
      } catch {
        this._invalidate_execution_context();
      }

      await delay(100);
    }
  }

  async waitForSelector({
    selector,
    state = "attached",
    timeout = 30_000,
  }: {
    selector: string;
    state?: WaitForSelectorState;
    timeout?: number;
  }): Promise<Element | null> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      const element = await this.find({ selector });

      if (state === "hidden") {
        if (element === null) {
          return null;
        }

        const is_visible = await element.isVisible();
        if (!is_visible) {
          return null;
        }
      } else if (element !== null) {
        if (state === "visible") {
          const is_visible = await element.isVisible();
          if (!is_visible) {
            await delay(100);
            continue;
          }
        }

        if (state === "ready") {
          const is_ready = await element.isReady();
          if (!is_ready) {
            await delay(100);
            continue;
          }
        }

        return element;
      }

      await delay(100);
    }

    if (state !== "hidden") {
      throw new Error(`Timeout waiting for selector: ${selector}`);
    }

    return null;
  }

  async waitForFunction({
    expression,
    timeout = 30_000,
    pollInterval = 100,
  }: {
    expression: string;
    timeout?: number;
    pollInterval?: number;
  }): Promise<any> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      const result = await this.evaluate({ expression });
      if (result) {
        return result;
      }
      await delay(pollInterval);
    }

    throw new Error(`Timeout waiting for function: ${expression.slice(0, 50)}...`);
  }

  async race({
    selectors = [],
    jsFunctions = [],
    visible = false,
    timeout = 30_000,
  }: {
    selectors?: string[];
    jsFunctions?: string[];
    visible?: boolean;
    timeout?: number;
  } = {}): Promise<[string, any]> {
    if (selectors.length === 0 && jsFunctions.length === 0) {
      throw new Error("At least one selector or js_function required");
    }

    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      for (const selector of selectors) {
        const element = await this.find({ selector });
        if (element) {
          if (visible) {
            const is_ready = await element.isReady();
            if (is_ready) {
              return [selector, element];
            }
          } else {
            return [selector, element];
          }
        }
      }

      for (const jsFunction of jsFunctions) {
        const result = await this.evaluate({ expression: jsFunction });
        if (result) {
          return [jsFunction, result];
        }
      }

      await delay(100);
    }

    throw new Error("Timeout waiting for conditions");
  }

  async content(): Promise<string> {
    const result = await this._cdp.send("DOM.getDocument", { depth: -1 });
    const root_id = Number(result.root?.nodeId ?? 0);
    const html = await this._cdp.send("DOM.getOuterHTML", { nodeId: root_id });
    return String(html.outerHTML ?? "");
  }

  async evaluate({ expression }: { expression: string }): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context_id = await this._ensure_execution_context();

      try {
        const result = await this._cdp.send("Runtime.evaluate", {
          expression,
          contextId: context_id,
          returnByValue: true,
          awaitPromise: true,
        });

        if (result.exceptionDetails) {
          throw new Error(`JavaScript error: ${String(result.exceptionDetails.text ?? "Unknown error")}`);
        }

        return result.result?.value;
      } catch (error) {
        if (attempt === 0 && this._is_stale_execution_context_error(error)) {
          this._invalidate_execution_context();
          this._frame_id = null;
          continue;
        }

        throw error;
      }
    }

    throw new Error("Failed to evaluate JavaScript in the active execution context");
  }

  async find({ selector, timeout = 5_000 }: { selector: string; timeout?: number }): Promise<Element | null> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout) {
      try {
        const doc = await this._cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        const element = await this._unified_query_selector(doc.root ?? {}, selector);
        if (element) {
          return element;
        }

        const iframe_element = await this._search_in_iframes(selector);
        if (iframe_element) {
          return iframe_element;
        }
      } catch (error) {
        if (!(error instanceof CDPError) || !String(error.message).includes("No node with given id")) {
          throw error;
        }
      }

      await delay(100);
    }

    return null;
  }

  private async _search_in_iframes(selector: string): Promise<Element | null> {
    try {
      const targets_result = await this._cdp.send("Target.getTargets");
      const iframe_targets = (targets_result.targetInfos ?? []).filter((target: Record<string, any>) => target.type === "iframe");

      for (const target of iframe_targets) {
        const target_id = target.targetId;
        if (!target_id) {
          continue;
        }

        const element = await this._search_in_oop_iframe(String(target_id), selector);
        if (element) {
          return element;
        }
      }

      const doc = await this._cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const iframes = this._find_all_iframes(doc.root ?? {});

      for (const iframe_info of iframes) {
        const backend_id = Number(iframe_info.backendNodeId ?? 0);
        if (!backend_id) {
          continue;
        }

        const element = await this._search_iframe_content(backend_id, selector);
        if (element) {
          return element;
        }
      }
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }

    return null;
  }

  private async _search_in_oop_iframe(target_id: string, selector: string): Promise<Element | null> {
    try {
      let session_id = this._oop_frame_sessions.get(target_id) ?? null;

      if (!session_id) {
        const attach_result = await this._cdp.send("Target.attachToTarget", {
          targetId: target_id,
          flatten: true,
        });

        session_id = attach_result.sessionId ?? null;
        if (session_id) {
          this._oop_frame_sessions.set(target_id, session_id);
          await this._init_oop_frame(session_id);
        }
      }

      if (!session_id) {
        return null;
      }

      const iframe_offset = await this._get_iframe_offset_for_target(target_id);
      await this._cdp.send("DOM.enable", {}, session_id);

      const doc_result = await this._cdp.send(
        "DOM.getDocument",
        {
          depth: -1,
          pierce: true,
        },
        session_id,
      );

      const root_id = Number(doc_result.root?.nodeId ?? 0);
      if (!root_id) {
        return null;
      }

      try {
        const query_result = await this._cdp.send(
          "DOM.querySelector",
          {
            nodeId: root_id,
            selector,
          },
          session_id,
        );

        const node_id = Number(query_result.nodeId ?? 0);
        if (node_id) {
          return new Element(this._cdp, node_id, selector, session_id, iframe_offset);
        }
      } catch (error) {
        if (!(error instanceof CDPError)) {
          throw error;
        }
      }

      const closed_srs = this._collect_all_shadow_roots(doc_result.root ?? {});
      for (const shadow_info of closed_srs) {
        if (shadow_info.type !== "closed") {
          continue;
        }

        const backend_id = Number(shadow_info.backendNodeId ?? 0);
        try {
          const resolved = await this._cdp.send(
            "DOM.resolveNode",
            {
              backendNodeId: backend_id,
            },
            session_id,
          );

          const shadow_object_id = resolved.object?.objectId;
          if (!shadow_object_id) {
            continue;
          }

          const query_result = await this._cdp.send(
            "Runtime.callFunctionOn",
            {
              objectId: shadow_object_id,
              functionDeclaration: `
                function() {
                    return this.querySelector(${JSON.stringify(selector)});
                }
              `,
              returnByValue: false,
            },
            session_id,
          );

          const element_object_id = query_result.result?.objectId;
          if (!element_object_id) {
            continue;
          }

          const node_result = await this._cdp.send(
            "DOM.requestNode",
            {
              objectId: element_object_id,
            },
            session_id,
          );

          const node_id = Number(node_result.nodeId ?? 0);
          if (node_id) {
            return new Element(this._cdp, node_id, selector, session_id, iframe_offset);
          }
        } catch (error) {
          if (!(error instanceof CDPError)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }

    return null;
  }

  private async _get_iframe_offset_for_target(_target_id: string): Promise<[number, number]> {
    try {
      const doc = await this._cdp.send("DOM.getDocument", { depth: -1, pierce: true });

      const find_iframes = (node: Record<string, any>): number[] => {
        const results: number[] = [];

        if (String(node.nodeName ?? "").toUpperCase() === "IFRAME") {
          const backend_id = Number(node.backendNodeId ?? 0);
          if (backend_id) {
            results.push(backend_id);
          }
        }

        for (const child of node.children ?? []) {
          results.push(...find_iframes(child));
        }

        for (const shadow_root of node.shadowRoots ?? []) {
          results.push(...find_iframes(shadow_root));
        }

        return results;
      };

      for (const backend_id of find_iframes(doc.root ?? {})) {
        try {
          const quads = await this._cdp.send("DOM.getContentQuads", {
            backendNodeId: backend_id,
          });

          const quads_list = quads.quads ?? [];
          if (quads_list.length > 0 && quads_list[0].length >= 2) {
            return [quads_list[0][0], quads_list[0][1]];
          }
        } catch (error) {
          if (!(error instanceof CDPError)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }

    return [0, 0];
  }

  private _find_all_iframes(node: Record<string, any>, results: Record<string, any>[] = []): Record<string, any>[] {
    if (String(node.nodeName ?? "").toUpperCase() === "IFRAME") {
      results.push({
        backendNodeId: node.backendNodeId,
        frameId: node.frameId,
      });
    }

    for (const child of node.children ?? []) {
      this._find_all_iframes(child, results);
    }

    for (const shadow_root of node.shadowRoots ?? []) {
      this._find_all_iframes(shadow_root, results);
    }

    return results;
  }

  private _collect_child_frames(frame_tree: Record<string, any>, results: Record<string, any>[] = []): Record<string, any>[] {
    for (const child of frame_tree.childFrames ?? []) {
      if (child.frame) {
        results.push(child.frame);
      }
      this._collect_child_frames(child, results);
    }

    return results;
  }

  private async _find_iframe_by_url(node: Record<string, any>, url: string): Promise<number[]> {
    const results: number[] = [];
    if (String(node.nodeName ?? "").toUpperCase() === "IFRAME") {
      const attrs = (node.attributes ?? []) as string[];
      for (let index = 0; index < attrs.length; index += 2) {
        if (attrs[index] === "src") {
          const src = attrs[index + 1] ?? "";
          if (url.includes(src) || src.includes(url) || this._urls_match(src, url)) {
            const backend_id = Number(node.backendNodeId ?? 0);
            if (backend_id) {
              results.push(backend_id);
            }
          }
        }
      }
    }

    for (const child of node.children ?? []) {
      results.push(...(await this._find_iframe_by_url(child, url)));
    }

    for (const shadow_root of node.shadowRoots ?? []) {
      results.push(...(await this._find_iframe_by_url(shadow_root, url)));
    }

    return results;
  }

  private _urls_match(url1: string, url2: string): boolean {
    try {
      const parsed1 = new URL(url1);
      const parsed2 = new URL(url2);
      return parsed1.host === parsed2.host && parsed1.pathname === parsed2.pathname;
    } catch {
      return false;
    }
  }

  private async _search_iframe_content(iframe_backend_id: number, selector: string): Promise<Element | null> {
    try {
      const result = await this._cdp.send("DOM.resolveNode", {
        backendNodeId: iframe_backend_id,
      });

      const iframe_object_id = result.object?.objectId;
      if (!iframe_object_id) {
        return null;
      }

      const content_doc_result = await this._cdp.send("Runtime.callFunctionOn", {
        objectId: iframe_object_id,
        functionDeclaration: `
          function() {
              try {
                  return this.contentDocument;
              } catch (e) {
                  return null;
              }
          }
        `,
        returnByValue: false,
      });

      const content_doc_id = content_doc_result.result?.objectId;
      if (!content_doc_id) {
        return await this._search_cross_origin_iframe(iframe_backend_id, selector);
      }

      const query_result = await this._cdp.send("Runtime.callFunctionOn", {
        objectId: content_doc_id,
        functionDeclaration: `
          function() {
              return this.querySelector(${JSON.stringify(selector)});
          }
        `,
        returnByValue: false,
      });

      const element_object_id = query_result.result?.objectId;
      if (!element_object_id) {
        return null;
      }

      const node_result = await this._cdp.send("DOM.requestNode", {
        objectId: element_object_id,
      });

      const node_id = Number(node_result.nodeId ?? 0);
      return node_id ? new Element(this._cdp, node_id, selector) : null;
    } catch (error) {
      if (error instanceof CDPError) {
        return null;
      }
      throw error;
    }
  }

  private async _search_cross_origin_iframe(iframe_backend_id: number, selector: string): Promise<Element | null> {
    try {
      const described = await this._cdp.send("DOM.describeNode", {
        backendNodeId: iframe_backend_id,
        depth: -1,
        pierce: true,
      });

      const frame_id = described.node?.frameId;
      if (!frame_id) {
        return null;
      }

      const world_result = await this._cdp.send("Page.createIsolatedWorld", {
        frameId: frame_id,
        worldName: "util",
      });

      const context_id = Number(world_result.executionContextId ?? 0);
      if (!context_id) {
        return null;
      }

      const direct_result = await this._cdp.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId: context_id,
        returnByValue: false,
      });

      const direct_object_id = direct_result.result?.objectId;
      if (direct_object_id) {
        try {
          const node_result = await this._cdp.send("DOM.requestNode", {
            objectId: direct_object_id,
          });

          const node_id = Number(node_result.nodeId ?? 0);
          if (node_id) {
            return new Element(this._cdp, node_id, selector);
          }
        } catch (error) {
          if (!(error instanceof CDPError)) {
            throw error;
          }
        }
      }

      const shadow_search_js = `
        (() => {
          const selector = ${JSON.stringify(selector)};
          function findInShadowRoots(root) {
            let result = root.querySelector(selector);
            if (result) return result;

            const allElements = root.querySelectorAll('*');
            for (const el of allElements) {
              if (el.shadowRoot) {
                result = findInShadowRoots(el.shadowRoot);
                if (result) return result;
              }
            }
            return null;
          }
          return findInShadowRoots(document);
        })()
      `;

      const shadow_result = await this._cdp.send("Runtime.evaluate", {
        expression: shadow_search_js,
        contextId: context_id,
        returnByValue: false,
      });

      const shadow_object_id = shadow_result.result?.objectId;
      if (shadow_object_id) {
        try {
          const node_result = await this._cdp.send("DOM.requestNode", {
            objectId: shadow_object_id,
          });

          const node_id = Number(node_result.nodeId ?? 0);
          if (node_id) {
            return new Element(this._cdp, node_id, selector);
          }
        } catch (error) {
          if (!(error instanceof CDPError)) {
            throw error;
          }
        }
      }

      const doc_result = await this._cdp.send("Runtime.evaluate", {
        expression: "document",
        contextId: context_id,
        returnByValue: false,
      });

      const doc_object_id = doc_result.result?.objectId;
      if (!doc_object_id) {
        return null;
      }

      const described_doc = await this._cdp.send("DOM.describeNode", {
        objectId: doc_object_id,
        depth: -1,
        pierce: true,
      });

      const closed_shadow_roots = this._collect_all_shadow_roots(described_doc.node ?? {});
      for (const shadow_info of closed_shadow_roots) {
        if (shadow_info.type !== "closed") {
          continue;
        }

        const backend_id = Number(shadow_info.backendNodeId ?? 0);
        try {
          const resolved = await this._cdp.send("DOM.resolveNode", {
            backendNodeId: backend_id,
            executionContextId: context_id,
          });

          const current_shadow_object_id = resolved.object?.objectId;
          if (!current_shadow_object_id) {
            continue;
          }

          const query_result = await this._cdp.send("Runtime.callFunctionOn", {
            objectId: current_shadow_object_id,
            functionDeclaration: `
              function() {
                  return this.querySelector(${JSON.stringify(selector)});
              }
            `,
            returnByValue: false,
          });

          const element_object_id = query_result.result?.objectId;
          if (!element_object_id) {
            continue;
          }

          const node_result = await this._cdp.send("DOM.requestNode", {
            objectId: element_object_id,
          });

          const node_id = Number(node_result.nodeId ?? 0);
          if (node_id) {
            return new Element(this._cdp, node_id, selector);
          }
        } catch (error) {
          if (!(error instanceof CDPError)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof CDPError) {
        return null;
      }
      throw error;
    }

    return null;
  }

  private async _unified_query_selector(root_node: Record<string, any>, selector: string): Promise<Element | null> {
    const root_id = Number(root_node.nodeId ?? 0);
    if (root_id) {
      try {
        const result = await this._cdp.send("DOM.querySelector", {
          nodeId: root_id,
          selector,
        });

        const node_id = Number(result.nodeId ?? 0);
        if (node_id) {
          return new Element(this._cdp, node_id, selector);
        }
      } catch (error) {
        if (!(error instanceof CDPError)) {
          throw error;
        }
      }
    }

    const all_shadow_roots = this._collect_all_shadow_roots(root_node);
    for (const shadow_info of all_shadow_roots) {
      const backend_id = Number(shadow_info.backendNodeId ?? 0);

      try {
        const result = await this._cdp.send("DOM.resolveNode", {
          backendNodeId: backend_id,
        });

        const object_id = result.object?.objectId;
        if (!object_id) {
          continue;
        }

        const query_result = await this._cdp.send("Runtime.callFunctionOn", {
          objectId: object_id,
          functionDeclaration: `
            function() {
                return this.querySelector(${JSON.stringify(selector)});
            }
          `,
          returnByValue: false,
        });

        const element_object_id = query_result.result?.objectId;
        if (!element_object_id) {
          continue;
        }

        const node_result = await this._cdp.send("DOM.requestNode", {
          objectId: element_object_id,
        });

        const node_id = Number(node_result.nodeId ?? 0);
        if (node_id) {
          return new Element(this._cdp, node_id, selector);
        }
      } catch (error) {
        if (!(error instanceof CDPError)) {
          throw error;
        }
      }
    }

    return null;
  }

  async findAll({ selector }: { selector: string }): Promise<Element[]> {
    const elements: Element[] = [];
    const doc = await this._cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const root_id = Number(doc.root?.nodeId ?? 0);

    try {
      const result = await this._cdp.send("DOM.querySelectorAll", {
        nodeId: root_id,
        selector,
      });

      for (const node_id of result.nodeIds ?? []) {
        if (node_id) {
          elements.push(new Element(this._cdp, Number(node_id), selector));
        }
      }
    } catch (error) {
      if (!(error instanceof CDPError)) {
        throw error;
      }
    }

    const all_shadow_roots = this._collect_all_shadow_roots(doc.root ?? {});
    for (const shadow_info of all_shadow_roots) {
      const backend_id = Number(shadow_info.backendNodeId ?? 0);

      try {
        const result = await this._cdp.send("DOM.resolveNode", {
          backendNodeId: backend_id,
        });

        const object_id = result.object?.objectId;
        if (!object_id) {
          continue;
        }

        const query_result = await this._cdp.send("Runtime.callFunctionOn", {
          objectId: object_id,
          functionDeclaration: `
            function() {
                return Array.from(this.querySelectorAll(${JSON.stringify(selector)}));
            }
          `,
          returnByValue: false,
        });

        const array_object_id = query_result.result?.objectId;
        if (!array_object_id) {
          continue;
        }

        const props = await this._cdp.send("Runtime.getProperties", {
          objectId: array_object_id,
          ownProperties: true,
        });

        for (const prop of props.result ?? []) {
          if (!/^\d+$/.test(String(prop.name ?? ""))) {
            continue;
          }

          const element_object_id = prop.value?.objectId;
          if (!element_object_id) {
            continue;
          }

          const node_result = await this._cdp.send("DOM.requestNode", {
            objectId: element_object_id,
          });

          const node_id = Number(node_result.nodeId ?? 0);
          if (node_id) {
            elements.push(new Element(this._cdp, node_id, selector));
          }
        }
      } catch (error) {
        if (!(error instanceof CDPError)) {
          throw error;
        }
      }
    }

    return elements;
  }

  private _collect_all_shadow_roots(node: Record<string, any>, results: Array<{ backendNodeId: number; type: string }> = []): Array<{ backendNodeId: number; type: string }> {
    for (const shadow_root of node.shadowRoots ?? []) {
      const backend_id = Number(shadow_root.backendNodeId ?? 0);
      const shadow_root_type = String(shadow_root.shadowRootType ?? "open");
      if (backend_id) {
        results.push({
          backendNodeId: backend_id,
          type: shadow_root_type,
        });
      }

      this._collect_all_shadow_roots(shadow_root, results);
    }

    for (const child of node.children ?? []) {
      this._collect_all_shadow_roots(child, results);
    }

    return results;
  }

  async screenshot({
    path = null,
    fullPage = false,
  }: {
    path?: string | null;
    fullPage?: boolean;
  } = {}): Promise<Buffer> {
    const params: Record<string, unknown> = { format: "png" };

    if (fullPage) {
      const metrics = await this._cdp.send("Page.getLayoutMetrics");
      const content_size = metrics.contentSize ?? {};
      params.clip = {
        x: 0,
        y: 0,
        width: content_size.width ?? 1920,
        height: content_size.height ?? 1080,
        scale: 1,
      };
    }

    const result = await this._cdp.send("Page.captureScreenshot", params);
    const data = Buffer.from(String(result.data ?? ""), "base64");

    if (path) {
      await writeFile(path, data);
    }

    return data;
  }

  async setCookies({ cookies }: { cookies: Array<Record<string, any>> }): Promise<void> {
    for (const cookie of cookies) {
      const params: Record<string, unknown> = {
        name: cookie.name ?? "",
        value: cookie.value ?? "",
        domain: cookie.domain ?? "",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
      };

      if (cookie.expires !== undefined) {
        params.expires = cookie.expires;
      }

      if (cookie.sameSite !== undefined) {
        params.sameSite = cookie.sameSite;
      }

      await this._cdp.send("Network.setCookie", params);
    }
  }

  async getCookies({ urls = null }: { urls?: string[] | null } = {}): Promise<Record<string, any>[]> {
    const params: Record<string, unknown> = {};
    if (urls) {
      params.urls = urls;
    }

    const result = await this._cdp.send("Network.getCookies", params);
    return result.cookies ?? [];
  }

  async clearCookies(): Promise<void> {
    await this._cdp.send("Network.clearBrowserCookies");
  }

  async setLocalStorage({ items }: { items: Record<string, string> }): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      await this.evaluate({ expression: `
        (() => {
          localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});
        })()
      ` });
    }
  }

  async getLocalStorage(): Promise<Record<string, string>> {
    const result = await this.evaluate({ expression: `
      (() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          items[key] = localStorage.getItem(key);
        }
        return items;
      })()
    ` });

    return (result ?? {}) as Record<string, string>;
  }

  async sleep({ milliseconds }: { milliseconds: number }): Promise<void> {
    await delay(milliseconds * random_between(0.5, 1.5));
  }

  // Injects JS that runs in every new document BEFORE any page script, via
  // Page.addScriptToEvaluateOnNewDocument. Ideal for fingerprint patches that
  // must win the race against the page's own detection code.
  async addInitScript({ source }: { source: string }): Promise<string> {
    const result = await this._cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    return String(result.identifier ?? "");
  }

  async removeInitScript({ identifier }: { identifier: string }): Promise<void> {
    await this._cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  async setExtraHeaders({ headers }: { headers: Record<string, string> }): Promise<void> {
    await this._cdp.send("Network.setExtraHTTPHeaders", { headers });
  }

  // Overrides the User-Agent and keeps the client-hint metadata consistent so
  // navigator.userAgentData and sec-ch-ua-* agree with the new string.
  async setUserAgent({ userAgent }: { userAgent: string }): Promise<void> {
    this._user_agent = userAgent;
    await this._cdp.send("Network.setUserAgentOverride", {
      userAgent,
      userAgentMetadata: build_user_agent_metadata(userAgent),
    });
  }

  async setGeolocation({
    latitude,
    longitude,
    accuracy = 100,
  }: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  }): Promise<void> {
    await this._cdp.send("Emulation.setGeolocationOverride", { latitude, longitude, accuracy });
  }

  async setTimezone({ timezoneId }: { timezoneId: string }): Promise<void> {
    await this._cdp.send("Emulation.setTimezoneOverride", { timezoneId });
  }

  async setLocale({ locale }: { locale: string }): Promise<void> {
    await this._cdp.send("Emulation.setLocaleOverride", { locale });
  }

  // Aligns every geo-derived signal in one call so they can't contradict each
  // other (a cross-layer mismatch is a strong bot signal). When proxying through
  // another country, pass that region's locale/timezone. acceptLanguage is set
  // via the UA override, which also keeps navigator.languages consistent.
  async emulateLocale({
    locale,
    timezone,
    acceptLanguage,
  }: {
    locale?: string;
    timezone?: string;
    acceptLanguage?: string;
  }): Promise<void> {
    if (timezone) {
      await this._cdp.send("Emulation.setTimezoneOverride", { timezoneId: timezone });
    }

    if (locale) {
      await this._cdp.send("Emulation.setLocaleOverride", { locale });
    }

    // Plain comma list (no q-values): Chrome derives navigator.languages from
    // this, and a q-value there would be an obvious tell real browsers never show.
    const accept_language = acceptLanguage ?? (locale ? `${locale},${locale.split("-")[0]}` : null);
    if (accept_language && this._user_agent) {
      await this._cdp.send("Network.setUserAgentOverride", {
        userAgent: this._user_agent,
        acceptLanguage: accept_language,
        userAgentMetadata: build_user_agent_metadata(this._user_agent),
      });
    } else if (accept_language) {
      await this._cdp.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": accept_language } });
    }
  }

  async setViewport({
    width,
    height,
    deviceScaleFactor = 1,
    mobile = false,
  }: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<void> {
    await this._cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  async bringToFront(): Promise<void> {
    await this._cdp.send("Page.bringToFront");
  }

  async pdf({ path = null, landscape = false }: { path?: string | null; landscape?: boolean } = {}): Promise<Buffer> {
    const result = await this._cdp.send("Page.printToPDF", { landscape, printBackground: true });
    const data = Buffer.from(String(result.data ?? ""), "base64");

    if (path) {
      await writeFile(path, data);
    }

    return data;
  }

  // Registers a handler for native dialogs (alert/confirm/prompt/beforeunload).
  // The handler decides whether to accept and what prompt text to submit;
  // without one, dialogs would hang the page until the renderer times out.
  onDialog(handler: (dialog: Dialog) => void | Promise<void>): void {
    this._cdp.on("Page.javascriptDialogOpening", (params) => {
      const dialog = new Dialog(this._cdp, params as Record<string, any>);
      void Promise.resolve(handler(dialog)).catch(() => undefined);
    });
  }

  get network(): Network {
    if (!this._network) {
      this._network = new Network(this._cdp);
    }

    return this._network;
  }

  // Shared human-like cursor for this tab; position persists across moves/clicks.
  get mouse(): HumanMouse {
    return getSharedMouse(this._cdp);
  }

  // Keyboard bound to the page; dispatches real keyDown/keyUp events.
  get keyboard(): Keyboard {
    return new Keyboard(this._cdp);
  }

  // Presses a single key at the page level (e.g. "Enter", "Tab", "Escape").
  async pressKey({ key }: { key: string }): Promise<void> {
    await this.keyboard.press(key);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

// Represents a native JS dialog (alert/confirm/prompt/beforeunload) surfaced
// through Page.javascriptDialogOpening. Call accept() or dismiss() exactly once.
export class Dialog {
  type: string;
  message: string;
  defaultPrompt: string;

  private _cdp: CDPClient;
  private _handled = false;

  constructor(cdp: CDPClient, params: Record<string, any>) {
    this._cdp = cdp;
    this.type = String(params.type ?? "alert");
    this.message = String(params.message ?? "");
    this.defaultPrompt = String(params.defaultPrompt ?? "");
  }

  async accept(promptText?: string): Promise<void> {
    if (this._handled) {
      return;
    }
    this._handled = true;
    await this._cdp.send("Page.handleJavaScriptDialog", {
      accept: true,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  }

  async dismiss(): Promise<void> {
    if (this._handled) {
      return;
    }
    this._handled = true;
    await this._cdp.send("Page.handleJavaScriptDialog", { accept: false });
  }
}

function random_between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Generates the main-world init script that overrides the WebGL UNMASKED
// vendor/renderer (params 37445/37446) on both WebGL1 and WebGL2 contexts. Uses
// an apply-trap Proxy so Function.prototype.toString stays native-looking.
function build_webgl_override_source(vendor: string, renderer: string): string {
  return `
    (() => {
      const VENDOR = ${JSON.stringify(vendor)};
      const RENDERER = ${JSON.stringify(renderer)};
      const UNMASKED_VENDOR = 0x9245;
      const UNMASKED_RENDERER = 0x9246;

      const patch = (proto) => {
        if (!proto || !proto.getParameter) return;
        const original = proto.getParameter;
        proto.getParameter = new Proxy(original, {
          apply(target, thisArg, args) {
            if (args[0] === UNMASKED_VENDOR) return VENDOR;
            if (args[0] === UNMASKED_RENDERER) return RENDERER;
            return Reflect.apply(target, thisArg, args);
          },
        });
      };

      if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
    })();
  `;
}

// Builds Client Hints metadata consistent with the given UA string so that
// navigator.userAgentData and the sec-ch-ua-* request headers agree with it.
function build_user_agent_metadata(user_agent: string): Record<string, unknown> {
  const major = user_agent.match(/Chrome\/(\d+)/)?.[1] ?? "120";

  let platform = "Windows";
  let platform_version = "10.0.0";
  if (user_agent.includes("Macintosh")) {
    platform = "macOS";
    platform_version = "13.0.0";
  } else if (user_agent.includes("Linux") && !user_agent.includes("Android")) {
    platform = "Linux";
    platform_version = "6.0.0";
  } else if (user_agent.includes("Android")) {
    platform = "Android";
    platform_version = "13.0.0";
  }

  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not?A_Brand", version: "24" },
  ];

  return {
    brands,
    fullVersionList: brands.map((entry) => ({ brand: entry.brand, version: `${entry.version}.0.0.0` })),
    platform,
    platformVersion: platform_version,
    architecture: "x86",
    bitness: "64",
    model: "",
    mobile: user_agent.includes("Android") || user_agent.includes("Mobile"),
    wow64: false,
  };
}