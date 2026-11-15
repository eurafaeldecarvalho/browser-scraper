import assert from "node:assert/strict";
import { test } from "node:test";

import { Browser, removeProfileDir } from "../../src/core/browser";
import { Tab } from "../../src/core/tab";

const enotempty = () => Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });

test("removeProfileDir retries while Chrome's helpers are still writing into the profile", async () => {
  let calls = 0;
  const rm = async () => {
    calls += 1;
    if (calls < 3) throw enotempty();
  };
  await removeProfileDir("/tmp/gdnium_x", { rm, retryDelayMs: 1 });
  assert.equal(calls, 3);
});

test("removeProfileDir never makes close() throw when the profile can't be removed", async () => {
  const rm = async () => {
    throw enotempty();
  };
  await assert.doesNotReject(removeProfileDir("/tmp/gdnium_x", { rm, retryDelayMs: 1 }));
});

test("attachTab closes the CDP socket when connect fails midway", async () => {
  const browser = new Browser({ headless: true });
  (browser as any).getTabs = async () => [{ id: "T1", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/x" }];
  const proto = Tab.prototype as any;
  const connect = proto.connect;
  const close = proto.close;
  let closed = 0;
  proto.connect = async () => {
    throw new Error("refused");
  };
  proto.close = async () => {
    closed += 1;
  };
  try {
    await assert.rejects(browser.attachTab("T1"), /refused/);
    assert.equal(closed, 1);
    assert.equal((browser as any)._tabs.length, 0);
  } finally {
    proto.connect = connect;
    proto.close = close;
  }
});
