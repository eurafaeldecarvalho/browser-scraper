import assert from "node:assert/strict";
import { test } from "node:test";

import { base64_cores, secret_forms } from "../../src/mcp/server";

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
  assert.deepEqual(secret_forms("hunter2secret").filter((f) => !base64_cores("hunter2secret").includes(f)), ["hunter2secret"]);
});

test("secret_forms covers base64 at any offset, strict percent-encoding and ASCII-only JSON", () => {
  const secret = "S3cr3t!pässw(rd)";
  const forms = secret_forms(secret);
  const redact = (text: string) => forms.reduce((out, f) => out.split(f).join("{{X}}"), text);
  for (const prefix of ["", "u:", "ab:", "user:"]) {
    const b64 = Buffer.from(prefix + secret).toString("base64");
    const out = redact(`Authorization: Basic ${b64}`);
    assert.ok(out.includes("{{X}}"), `base64 offset ${prefix.length} not redacted: ${out}`);
    const url = redact(Buffer.from(prefix + secret).toString("base64url"));
    assert.ok(url.includes("{{X}}"), `base64url offset ${prefix.length}`);
  }
  assert.ok(forms.includes("S3cr3t%21p%C3%A4ssw%28rd%29"));
  assert.ok(forms.includes("S3cr3t!p\\u00e4ssw(rd)"));
  assert.ok(forms.includes("S3cr3t!p\\u00E4ssw(rd)"));
  assert.deepEqual(base64_cores("short"), []);
});

test("_redact computes secret forms once and stays fast per snapshot node", async () => {
  const { McpServer } = await import("../../src/mcp/server");
  const server = new McpServer({ secrets: { A: "123456", B: "S3cr3t!pässw(rd)'*", C: "hunter2" } });
  const redact = (t: string) => (server as any)._redact(t);
  assert.equal(redact("x S3cr3t!pässw(rd)'* y 123456"), "x {{B}} y {{A}}");
  const pairs = (server as any)._redaction_pairs();
  assert.equal((server as any)._redaction_pairs(), pairs);
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) redact(`link item number ${i} Mozilla`);
  assert.ok(performance.now() - t0 < 1500, "20k node names must redact well under 1.5 s");
  assert.equal(redact("plain README text with no secret"), "plain README text with no secret");
});
