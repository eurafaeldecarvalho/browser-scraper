import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { finalize_download } from "../../src/mcp/server";

test("finalize_download retries a rename blocked by a transient Windows lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-dl-"));
  writeFileSync(join(dir, "guid-1"), "data");
  let calls = 0;
  const flaky = (from: string, to: string) => {
    calls += 1;
    if (calls < 3) {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    }
    renameSync(from, to);
  };
  const path = await finalize_download(dir, "guid-1", "cv.pdf", flaky, 1);
  assert.equal(path, join(dir, "cv.pdf"));
  assert.equal(readFileSync(path, "utf8"), "data");
  assert.equal(calls, 3);
});

test("finalize_download falls back to the GUID path and frees the reserved name on a hard failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-dl-"));
  writeFileSync(join(dir, "guid-2"), "data");
  const broken = () => {
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  const path = await finalize_download(dir, "guid-2", "../../evil.txt", broken, 1);
  assert.equal(path, join(dir, "guid-2"));
  assert.equal(existsSync(join(dir, "evil.txt")), false);
});

test("finalize_download never overwrites a same-named file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-dl-"));
  writeFileSync(join(dir, "a.txt"), "old");
  writeFileSync(join(dir, "guid-3"), "new");
  const path = await finalize_download(dir, "guid-3", "a.txt");
  assert.equal(path, join(dir, "a (1).txt"));
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "old");
});

test("finalize_download never rejects when the reserved placeholder cannot be removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-dl-"));
  writeFileSync(join(dir, "guid-9"), "data");
  const broken = () => {
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  const locked = () => {
    throw Object.assign(new Error("locked"), { code: "EPERM" });
  };
  const path = await finalize_download(dir, "guid-9", "cv.pdf", broken, 1, 10, locked);
  assert.equal(path, join(dir, "guid-9"));
});
