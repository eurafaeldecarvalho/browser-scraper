import assert from "node:assert/strict";
import { test } from "node:test";

import { js_exception_message } from "../../src/core/tab";

test("js_exception_message keeps the thrown message, not CDP's bare 'Uncaught'", () => {
  const details = { text: "Uncaught", exception: { description: "Error: boom\n    at <anonymous>:1:7\n    at <anonymous>:1:30" } };
  assert.equal(js_exception_message(details), "Error: boom");
});

test("js_exception_message handles thrown primitives and missing details", () => {
  assert.equal(js_exception_message({ text: "Uncaught", exception: { type: "string", value: "plain" } }), 'Uncaught "plain"');
  assert.equal(js_exception_message({ text: "Uncaught" }), "Uncaught");
  assert.equal(js_exception_message({}), "Unknown error");
});
