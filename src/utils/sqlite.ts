// Minimal synchronous SQLite surface used by ProfileManager. Resolved lazily so
// importing the library never requires a native module: `better-sqlite3` (an OPTIONAL
// dependency — its native build fails on some Node/OS combos) is used when it
// installed, else Node's built-in `node:sqlite` (>= 22.5).
export type SqliteStatement = {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export function openSqlite(path: string): SqliteDatabase {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    return new Database(path) as SqliteDatabase;
  } catch {
    // fall through to node:sqlite
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = without_sqlite_warning(() => require("node:sqlite"));
    return new DatabaseSync(path) as SqliteDatabase;
  } catch {
    throw new Error(
      "[browser-scraper] Profile seeding needs SQLite: use Node >= 22.5 (built-in node:sqlite) or install the optional dependency `better-sqlite3`.",
    );
  }
}

// node:sqlite prints an ExperimentalWarning on first load (Node 22/24); this is
// library-internal profile seeding, so keep it off the user's stderr.
function without_sqlite_warning<T>(fn: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite/i.test(String(text))) {
      return;
    }
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}
