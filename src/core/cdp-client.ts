import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { type RawData } from "ws";

export class CDPError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data: unknown = null) {
    super(`CDP Error ${code}: ${message}`);
    this.name = "CDPError";
    this.code = code;
    this.data = data;
  }
}

type CDPEventHandler = (params: Record<string, unknown>) => void | Promise<void>;

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class CDPClient {
  ws_url: string;

  private _ws: WebSocket | null = null;
  private _message_id = 0;
  private _pending_commands = new Map<number, PendingCommand>();
  private _event_handlers = new Map<string, CDPEventHandler[]>();
  private _disconnect_handlers: Array<(error: CDPError) => void> = [];
  private _connected = false;
  // Guards against firing the disconnect path twice: a dying socket emits
  // 'error' first and then 'close', and a graceful disconnect() also closes.
  private _disconnect_notified = false;

  constructor(ws_url: string) {
    this.ws_url = ws_url;
  }

  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    this._ws = new WebSocket(this.ws_url, {
      handshakeTimeout: 5_000,
      maxPayload: 0,
    });

    await new Promise<void>((resolve, reject) => {
      const ws = this._ws as WebSocket;

      const handleOpen = (): void => {
        ws.off("error", handleError);
        resolve();
      };

      const handleError = (error: Error): void => {
        ws.off("open", handleOpen);
        reject(error);
      };

      ws.once("open", handleOpen);
      ws.once("error", handleError);
    });

    this._connected = true;
    this._disconnect_notified = false;

    this._ws.on("message", (message: RawData) => {
      void this._handle_message(message.toString());
    });

    this._ws.on("close", () => {
      this._handle_disconnect(new CDPError(-1, "CDP WebSocket connection closed"));
    });

    this._ws.on("error", (error: Error) => {
      // A mid-run Chrome death surfaces HERE first (before 'close'). Without
      // rejecting the in-flight commands they hang until their 30s timeout, and
      // an unhandled 'error' on the socket can take down the whole Node process.
      // Reject pending fast with a typed error and notify disconnect listeners
      // so the caller can fail ONE run gracefully instead of stalling/crashing.
      this._handle_disconnect(new CDPError(-1, `CDP WebSocket error: ${error?.message ?? String(error)}`));
    });
  }

  async disconnect(): Promise<void> {
    if (!this._connected || !this._ws) {
      return;
    }

    const ws = this._ws;
    this._connected = false;
    // A graceful disconnect is EXPECTED, not a crash: mark it handled first so
    // the resulting 'close' event does not fire the onDisconnect listeners.
    this._disconnect_notified = true;
    this._ws = null;

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      void delay(5_000).then(() => resolve());
    });

    this._reject_pending(new CDPError(-1, "CDP connection closed"));
  }

  // Registers a callback fired ONCE when the CDP transport dies unexpectedly
  // (socket 'error' or 'close' that wasn't a graceful disconnect()). Lets
  // Tab/Browser surface a mid-run Chrome death as a recoverable, typed failure
  // for the current operation instead of a 30s hang or an unhandled socket error.
  onDisconnect(handler: (error: CDPError) => void): void {
    this._disconnect_handlers.push(handler);
  }

  offDisconnect(handler: (error: CDPError) => void): void {
    this._disconnect_handlers = this._disconnect_handlers.filter((candidate) => candidate !== handler);
  }

  get connected(): boolean {
    return this._connected;
  }

  // Fired at most once per connection lifetime (a dying socket emits 'error'
  // then 'close'). Marks disconnected, rejects every in-flight command so
  // callers fail fast with a typed error, then notifies disconnect listeners.
  private _handle_disconnect(error: CDPError): void {
    this._connected = false;
    if (this._disconnect_notified) {
      this._reject_pending(error);
      return;
    }
    this._disconnect_notified = true;
    this._reject_pending(error);
    for (const handler of this._disconnect_handlers) {
      try {
        handler(error);
      } catch {
        // A listener error must never mask the disconnect itself.
      }
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    session_id: string | null = null,
  ): Promise<any> {
    if (!this._connected) {
      await this.connect();
    }

    if (!this._ws) {
      throw new CDPError(-1, "CDP WebSocket not connected");
    }

    this._message_id += 1;
    const msg_id = this._message_id;

    const message: Record<string, unknown> = {
      id: msg_id,
      method,
    };

    if (Object.keys(params).length > 0) {
      message.params = params;
    }

    if (session_id) {
      message.sessionId = session_id;
    }

    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending_commands.delete(msg_id);
        reject(new CDPError(-1, `Timeout waiting for response to ${method}`));
      }, 30_000);

      this._pending_commands.set(msg_id, {
        resolve,
        reject,
        timeout,
      });
    });

    await new Promise<void>((resolve, reject) => {
      this._ws?.send(JSON.stringify(message), (error?: Error) => {
        if (error) {
          this._pending_commands.delete(msg_id);
          reject(error);
          return;
        }
        resolve();
      });
    });

    return result;
  }

  on(event: string, handler: CDPEventHandler): void {
    const handlers = this._event_handlers.get(event) ?? [];
    handlers.push(handler);
    this._event_handlers.set(event, handlers);
  }

  off(event: string, handler: CDPEventHandler): void {
    const handlers = this._event_handlers.get(event);
    if (!handlers) {
      return;
    }

    this._event_handlers.set(
      event,
      handlers.filter((candidate) => candidate !== handler),
    );
  }

  private _reject_pending(error: CDPError): void {
    for (const [id, pending] of this._pending_commands.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this._pending_commands.delete(id);
    }
  }

  private async _handle_message(raw_message: string): Promise<void> {
    let message: any;

    try {
      message = JSON.parse(raw_message);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this._pending_commands.get(message.id);
      if (!pending) {
        return;
      }

      this._pending_commands.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(
          new CDPError(
            Number(message.error.code ?? -1),
            String(message.error.message ?? "Unknown error"),
            message.error.data,
          ),
        );
        return;
      }

      pending.resolve(message.result ?? {});
      return;
    }

    if (typeof message.method === "string") {
      await this._dispatch_event(message.method, (message.params ?? {}) as Record<string, unknown>);
    }
  }

  private async _dispatch_event(event: string, params: Record<string, unknown>): Promise<void> {
    const handlers = this._event_handlers.get(event) ?? [];
    for (const handler of handlers) {
      await handler(params);
    }
  }
}