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

test("secret_forms covers nested URL encoding, numeric entities and Go-style JSON", () => {
  const secret = 'p@ss w0rd/"x&y';
  const forms = secret_forms(secret);
  for (const leaked of [
    "p%2540ss%2520w0rd%252F%2522x%2526y", // redirect_uri=...%3Fpw%3D<secret>
    "p%2540ss%2Bw0rd%252F%2522x%2526y",
    "p@ss w0rd/&#34;x&#38;y",
    "p@ss w0rd/&#x22;x&#x26;y",
    'p@ss w0rd\\/\\"x\\u0026y',
    'p@ss w0rd/\\"x&amp;y', // evaluate("document.body.innerHTML")
  ]) {
    assert.ok(forms.includes(leaked), `missing form ${leaked}`);
  }
});

test("secret_forms of a plain value is just the value", () => {
  assert.deepEqual(secret_forms("hunter2secret"), ["hunter2secret"]);
});
