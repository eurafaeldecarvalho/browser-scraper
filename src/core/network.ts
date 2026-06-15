import { CDPClient } from "./cdp-client";

type HeaderMap = Record<string, string>;
type Handler<T extends unknown[]> = (...args: T) => void | Promise<void>;

export class Request {
  request_id: string;
  url: string;
  method: string;
  headers: Record<string, any>;
  post_data: string | null;
  resource_type: string;

  private _cdp: CDPClient | null;
  private _intercepted: boolean;

  constructor(
    request_id: string,
    url: string,
    method: string,
    headers: Record<string, any>,
    post_data: string | null = null,
    resource_type = "Other",
    cdp: CDPClient | null = null,
    intercepted = false,
  ) {
    this.request_id = request_id;
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.post_data = post_data;
    this.resource_type = resource_type;
    this._cdp = cdp;
    this._intercepted = intercepted;
  }

  async continueRequest({
    url = null,
    method = null,
    headers = null,
    postData = null,
  }: {
    url?: string | null;
    method?: string | null;
    headers?: HeaderMap | null;
    postData?: string | null;
  } = {}): Promise<void> {
    if (!this._cdp || !this._intercepted) {
      return;
    }

    const params: Record<string, unknown> = { requestId: this.request_id };

    if (url) {
      params.url = url;
    }

    if (method) {
      params.method = method;
    }

    if (headers) {
      params.headers = Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      }));
    }

    if (postData) {
      params.postData = Buffer.from(postData).toString("base64");
    }

    await this._cdp.send("Fetch.continueRequest", params);
  }

  async abort({ reason = "Failed" }: { reason?: string } = {}): Promise<void> {
    if (!this._cdp || !this._intercepted) {
      return;
    }

    await this._cdp.send("Fetch.failRequest", {
      requestId: this.request_id,
      errorReason: reason,
    });
  }

  async respond({
    status = 200,
    headers = null,
    body = null,
    jsonData = null,
  }: {
    status?: number;
    headers?: HeaderMap | null;
    body?: string | null;
    jsonData?: unknown;
  } = {}): Promise<void> {
    if (!this._cdp || !this._intercepted) {
      return;
    }

    const response_headers: HeaderMap = { ...(headers ?? {}) };
    let response_body = body ?? "";

    if (jsonData !== null && jsonData !== undefined) {
      response_body = JSON.stringify(jsonData);
      response_headers["Content-Type"] = "application/json";
    }

    await this._cdp.send("Fetch.fulfillRequest", {
      requestId: this.request_id,
      responseCode: status,
      responseHeaders: Object.entries(response_headers).map(([name, value]) => ({
        name,
        value,
      })),
      body: Buffer.from(response_body).toString("base64"),
    });
  }
}

export class Response {
  request_id: string;
  url: string;
  status: number;
  status_text: string;
  headers: Record<string, any>;
  mime_type: string;

  private _cdp: CDPClient | null;
  private _body: string | null = null;
  private _body_fetched = false;

  constructor(
    request_id: string,
    url: string,
    status: number,
    status_text: string,
    headers: Record<string, any>,
    mime_type: string,
    cdp: CDPClient | null = null,
  ) {
    this.request_id = request_id;
    this.url = url;
    this.status = status;
    this.status_text = status_text;
    this.headers = headers;
    this.mime_type = mime_type;
    this._cdp = cdp;
  }

  async body(): Promise<string> {
    if (this._body_fetched) {
      return this._body ?? "";
    }

    if (!this._cdp) {
      return "";
    }

    try {
      const result = await this._cdp.send("Network.getResponseBody", {
        requestId: this.request_id,
      });

      let body = String(result.body ?? "");
      if (result.base64Encoded) {
        body = Buffer.from(body, "base64").toString("utf-8");
      }

      this._body = body;
      this._body_fetched = true;
      return body;
    } catch {
      return "";
    }
  }

  async json(): Promise<any> {
    const body = await this.body();
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
}

export class Network {
  private _cdp: CDPClient;
  private _enabled = false;
  private _fetch_enabled = false;

  private _request_handlers: Handler<[Request]>[] = [];
  private _response_handlers: Handler<[Response]>[] = [];
  private _loading_finished_handlers: Handler<[string]>[] = [];
  private _loading_failed_handlers: Handler<[string, string]>[] = [];
  private _intercept_handlers: Array<{ pattern: string; resourceType: string | null; handler: Handler<[Request]> }> = [];
  private _requests = new Map<string, Request>();
  private _handle_auth_requests = false;
  private _proxy_auth: [string, string] | null = null;

  constructor(cdp: CDPClient) {
    this._cdp = cdp;
  }

  async enable(): Promise<void> {
    if (this._enabled) {
      return;
    }

    await this._cdp.send("Network.enable");
    this._cdp.on("Network.requestWillBeSent", (params) => this._on_request(params));
    this._cdp.on("Network.responseReceived", (params) => this._on_response(params));
    this._cdp.on("Network.loadingFinished", (params) => this._on_loading_finished(params));
    this._cdp.on("Network.loadingFailed", (params) => this._on_loading_failed(params));
    this._enabled = true;
  }

  /**
   * Routes proxy credential challenges through the Fetch domain. Calling this is
   * what lets interception coexist with an authenticated proxy: a single
   * `Fetch.enable` carries both `handleAuthRequests` and the interception
   * patterns, and a single `Fetch.requestPaused` listener (`_on_fetch_paused`)
   * owns every paused request — so adding block rules later never clobbers the
   * proxy auth or double-registers a competing pause handler.
   */
  async setProxyAuth(auth: [string, string]): Promise<void> {
    this._proxy_auth = auth;
    this._handle_auth_requests = true;

    this._cdp.on("Fetch.authRequired", (params) => {
      void (async () => {
        const challenge = (params.authChallenge ?? {}) as Record<string, any>;
        try {
          if (challenge.source === "Proxy") {
            await this._cdp.send("Fetch.continueWithAuth", {
              requestId: params.requestId,
              authChallengeResponse: {
                response: "ProvideCredentials",
                username: auth[0],
                password: auth[1],
              },
            });
            return;
          }
          await this._cdp.send("Fetch.continueWithAuth", {
            requestId: params.requestId,
            authChallengeResponse: { response: "CancelAuth" },
          });
        } catch {
          // Challenge already resolved / connection gone — nothing to recover.
        }
      })();
    });

    await this._enable_fetch_now();
  }

  /**
   * (Re)issues `Fetch.enable` reflecting the current interception rules and proxy
   * auth state. With block rules present, only requests matching those rules
   * (by URL glob and/or resourceType) pause — all other traffic, including the
   * reCAPTCHA / anti-bot requests, flows untouched, so interception adds no
   * observable surface to those requests. Resource-type filtering is applied at
   * the CDP pattern level so the matching requests never even reach the renderer
   * as a paused round-trip for unrelated traffic.
   */
  private async _enable_fetch_now(): Promise<void> {
    const has_rules = this._intercept_handlers.length > 0;
    if (!has_rules && !this._handle_auth_requests) {
      return;
    }

    const params: Record<string, unknown> = {};

    if (this._handle_auth_requests) {
      // Proxy auth needs EVERY request to pause so its auth challenge surfaces as
      // a Fetch.authRequired event. Restricting `patterns` would let a request
      // that needs proxy credentials slip through unauthenticated
      // (net::ERR_INVALID_AUTH_CREDENTIALS). So with proxy auth we pause all and
      // let `_on_fetch_paused` abort only the blocked URLs/types and continue the
      // rest. (CDP cannot filter the pause set by resourceType while still
      // catching auth challenges on every request.)
      params.handleAuthRequests = true;
    } else {
      // No proxy auth: pause ONLY the requests we intend to block — filtered by
      // URL glob and/or resourceType at the CDP level — so all other traffic,
      // including the reCAPTCHA / anti-bot requests, is never intercepted.
      params.patterns = this._intercept_handlers.map((entry) => {
        const pattern: Record<string, unknown> = {
          urlPattern: entry.pattern,
          requestStage: "Request",
        };
        if (entry.resourceType) {
          pattern.resourceType = entry.resourceType;
        }
        return pattern;
      });
    }

    await this._cdp.send("Fetch.enable", params);

    if (!this._fetch_enabled) {
      this._cdp.on("Fetch.requestPaused", (params) => this._on_fetch_paused(params));
      this._fetch_enabled = true;
    }
  }

  on({ event, handler }: { event: "request" | "response" | "finished" | "failed"; handler?: Handler<any> }): any {
    const register = <T extends Handler<any>>(fn: T): T => {
      if (event === "request") {
        this._request_handlers.push(fn as Handler<[Request]>);
      } else if (event === "response") {
        this._response_handlers.push(fn as Handler<[Response]>);
      } else if (event === "finished") {
        this._loading_finished_handlers.push(fn as Handler<[string]>);
      } else if (event === "failed") {
        this._loading_failed_handlers.push(fn as Handler<[string, string]>);
      } else {
        throw new Error(`Unknown event: ${event}`);
      }

      void this.enable();
      return fn;
    };

    if (handler) {
      return register(handler);
    }

    return register;
  }

  intercept({
    pattern = "*",
    resourceType = null,
    handler,
  }: {
    pattern?: string;
    resourceType?: string | null;
    handler?: Handler<[Request]>;
  }): any {
    const register = <T extends Handler<[Request]>>(fn: T): T => {
      this._intercept_handlers.push({ pattern, resourceType, handler: fn });
      void this._enable_fetch_now();
      return fn;
    };

    if (handler) {
      return register(handler);
    }

    return register;
  }

  private async _run_handlers<T extends unknown[]>(handlers: Handler<T>[], ...args: T): Promise<void> {
    for (const handler of handlers) {
      await handler(...args);
    }
  }

  private async _on_request(params: Record<string, any>): Promise<void> {
    const request_data = params.request ?? {};
    const request = new Request(
      String(params.requestId ?? ""),
      String(request_data.url ?? ""),
      String(request_data.method ?? "GET"),
      (request_data.headers ?? {}) as Record<string, any>,
      request_data.postData ? String(request_data.postData) : null,
      String(params.type ?? "Other"),
      this._cdp,
      false,
    );

    this._requests.set(request.request_id, request);
    await this._run_handlers(this._request_handlers, request);
  }

  private async _on_response(params: Record<string, any>): Promise<void> {
    const response_data = params.response ?? {};
    const response = new Response(
      String(params.requestId ?? ""),
      String(response_data.url ?? ""),
      Number(response_data.status ?? 0),
      String(response_data.statusText ?? ""),
      (response_data.headers ?? {}) as Record<string, any>,
      String(response_data.mimeType ?? ""),
      this._cdp,
    );

    await this._run_handlers(this._response_handlers, response);
  }

  private async _on_loading_finished(params: Record<string, any>): Promise<void> {
    await this._run_handlers(this._loading_finished_handlers, String(params.requestId ?? ""));
  }

  private async _on_loading_failed(params: Record<string, any>): Promise<void> {
    await this._run_handlers(
      this._loading_failed_handlers,
      String(params.requestId ?? ""),
      String(params.errorText ?? ""),
    );
  }

  private async _on_fetch_paused(params: Record<string, any>): Promise<void> {
    const request_data = params.request ?? {};
    const request = new Request(
      String(params.requestId ?? ""),
      String(request_data.url ?? ""),
      String(request_data.method ?? "GET"),
      (request_data.headers ?? {}) as Record<string, any>,
      request_data.postData ? String(request_data.postData) : null,
      String(params.resourceType ?? "Other"),
      this._cdp,
      true,
    );

    let handled = false;
    for (const { pattern, resourceType, handler } of this._intercept_handlers) {
      if (resourceType && request.resource_type !== resourceType) {
        continue;
      }
      if (match_glob(request.url, pattern)) {
        try {
          await handler(request);
        } catch {
          await request.continueRequest();
        }
        handled = true;
        break;
      }
    }

    if (!handled) {
      await request.continueRequest();
    }
  }

  /**
   * Aborts requests matching URL glob `patterns` and/or any of `resourceTypes`
   * (e.g. "Image", "Media", "Font", "Stylesheet"). Aborting with
   * `BlockedByClient` makes the dropped requests look like a content blocker
   * (uBlock-style) rather than automation. resourceType blocks pause ONLY those
   * types at the CDP level, leaving scripts/XHR/documents — and the reCAPTCHA /
   * anti-bot traffic — completely untouched. EXCEPTION: when an authenticated
   * proxy is in use, `Fetch.enable` must pause every request (no `patterns`) to
   * surface the proxy auth challenge, so unrelated requests take a pass-through
   * pause + `continueRequest` (never modified) rather than bypassing Fetch.
   */
  async block({
    patterns = [],
    resourceTypes = [],
  }: {
    patterns?: string[];
    resourceTypes?: string[];
  }): Promise<void> {
    const abort = async (request: Request): Promise<void> => {
      await request.abort({ reason: "BlockedByClient" });
    };
    for (const pattern of patterns) {
      this.intercept({ pattern, handler: abort });
    }
    for (const resourceType of resourceTypes) {
      this.intercept({ pattern: "*", resourceType, handler: abort });
    }
  }
}

function match_glob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}