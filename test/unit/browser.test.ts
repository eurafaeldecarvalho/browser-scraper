import assert from "node:assert/strict";
import { test } from "node:test";

import { removeProfileDir } from "../../src/core/browser";

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
