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
  private _intercept_handlers: Array<[string, Handler<[Request]>]> = [];
  private _requests = new Map<string, Request>();

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

  private async _enable_fetch(patterns: string[]): Promise<void> {
    if (patterns.length === 0) {
      return;
    }

    const cdp_patterns = patterns.map((pattern) => ({
      urlPattern: pattern,
      requestStage: "Request",
    }));

    await this._cdp.send("Fetch.enable", { patterns: cdp_patterns });

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

  intercept({ pattern = "*", handler }: { pattern?: string; handler?: Handler<[Request]> }): any {
    const register = <T extends Handler<[Request]>>(fn: T): T => {
      this._intercept_handlers.push([pattern, fn]);
      const all_patterns = [...new Set(this._intercept_handlers.map(([current]) => current))];
      void this._enable_fetch(all_patterns);
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
    for (const [pattern, handler] of this._intercept_handlers) {
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

  async block({ patterns }: { patterns: string[] }): Promise<void> {
    for (const pattern of patterns) {
      this.intercept({ pattern, handler: async (request: Request) => {
        await request.abort({ reason: "BlockedByClient" });
      } });
    }
  }
}

function match_glob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}