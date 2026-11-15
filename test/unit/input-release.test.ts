import assert from "node:assert/strict";
import test from "node:test";
import { addSendGuard, CDPClient } from "../../src/core/cdp-client";
import { Keyboard } from "../../src/behavior/keyboard";
import { HumanMouse } from "../../src/behavior/mouse";

// A CDPClient whose commands pass through the real send guards; commands that
// get past them are recorded as delivered (the socket itself is unreachable).
class RecordingCDP extends CDPClient {
  delivered: Array<{ method: string; type: unknown; key?: unknown }> = [];
  after_first?: () => void;
  async send(method: string, params: Record<string, unknown> = {}, session_id: string | null = null): Promise<any> {
    try {
      await super.send(method, params, session_id);
    } catch (error) {
      if (/abandoned/.test(String((error as Error).message))) {
        throw error;
      }
    }
    this.delivered.push({ method, type: params.type, key: params.key });
    if (params.type === "rawKeyDown" || params.type === "mousePressed" || params.type === "keyDown") {
      this.after_first?.();
    }
    return {};
  }
}

async function with_guard(fn: (abandon: () => void) => Promise<void>): Promise<void> {
  let stale = false;
  const remove = addSendGuard(() => {
    if (stale) {
      throw new Error("This call timed out and was abandoned.");
    }
  });
  try {
    await fn(() => {
      stale = true;
    });
  } finally {
    remove();
  }
}

test("a shortcut abandoned after a modifier went down still releases it", async () => {
  await with_guard(async (abandon) => {
    const cdp = new RecordingCDP("ws://127.0.0.1:1/devtools/page/X");
    cdp.after_first = abandon;
    await assert.rejects(new Keyboard(cdp).press("Control+a"), /abandoned/);
    assert.ok(cdp.delivered.some((entry) => entry.type === "keyUp" && entry.key === "Control"), JSON.stringify(cdp.delivered));
  });
});

test("a key press abandoned after its keyDown still sends the keyUp", async () => {
  await with_guard(async (abandon) => {
    const cdp = new RecordingCDP("ws://127.0.0.1:1/devtools/page/X");
    cdp.after_first = abandon;
    await new Keyboard(cdp).press("Enter");
    assert.ok(cdp.delivered.some((entry) => entry.type === "keyUp" && entry.key === "Enter"), JSON.stringify(cdp.delivered));
  });
});

test("a mouse click abandoned after mousePressed still sends mouseReleased", async () => {
  await with_guard(async (abandon) => {
    const cdp = new RecordingCDP("ws://127.0.0.1:1/devtools/page/X");
    cdp.after_first = abandon;
    await new HumanMouse(cdp).click({ x: 10, y: 10 });
    assert.ok(cdp.delivered.some((entry) => entry.type === "mouseReleased"), JSON.stringify(cdp.delivered));
  });
});
