import assert from "node:assert/strict";
import { test } from "node:test";

import { secret_forms } from "../../src/mcp/server";

test("secret_forms covers URL, form, JSON and HTML encodings", () => {
  const secret = 'p@ss w0rd/"x&y';
  const forms = secret_forms(secret);
  for (const leaked of [
    secret,
    "p%40ss%20w0rd%2F%22x%26y",
    "p%40ss+w0rd%2F%22x%26y",
    "p%40ss%20w0rd%2f%22x%26y",
    'p@ss w0rd/\\"x&y',
    "p@ss w0rd/&quot;x&amp;y",
  ]) {
    assert.ok(forms.includes(leaked), `missing form ${leaked}`);
  }
  // longest first, so a raw value inside an encoded one is not replaced first
  for (let i = 1; i < forms.length; i++) assert.ok(forms[i - 1].length >= forms[i].length);
});

test("secret_forms of a plain value is just the value", () => {
  assert.deepEqual(secret_forms("hunter2secret"), ["hunter2secret"]);
});
