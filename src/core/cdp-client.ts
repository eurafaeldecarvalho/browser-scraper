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
  private _connected = false;

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

    this._ws.on("message", (message: RawData) => {
      void this._handle_message(message.toString());
    });

    this._ws.on("close", () => {
      this._connected = false;
      this._reject_pending(new CDPError(-1, "CDP WebSocket connection closed"));
    });

    this._ws.on("error", () => {
      this._connected = false;
    });
  }

  async disconnect(): Promise<void> {
    if (!this._connected || !this._ws) {
      return;
    }

    const ws = this._ws;
    this._connected = false;
    this._ws = null;

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      void delay(5_000).then(() => resolve());
    });

    this._reject_pending(new CDPError(-1, "CDP connection closed"));
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