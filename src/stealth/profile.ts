import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

export type HistorySite = [string, string, number];

export const DEFAULT_HISTORY_SITES: HistorySite[] = [
  ["https://www.google.com/", "Google", 50],
  ["https://www.youtube.com/", "YouTube", 45],
  ["https://www.gmail.com/", "Gmail", 30],
  ["https://www.facebook.com/", "Facebook", 20],
  ["https://twitter.com/", "X", 15],
  ["https://www.reddit.com/", "Reddit", 18],
  ["https://www.amazon.com/", "Amazon", 15],
  ["https://www.wikipedia.org/", "Wikipedia", 20],
  ["https://www.linkedin.com/", "LinkedIn", 10],
  ["https://www.instagram.com/", "Instagram", 25],
  ["https://github.com/", "GitHub", 20],
  ["https://stackoverflow.com/", "Stack Overflow", 15],
  ["https://www.netflix.com/", "Netflix", 12],
  ["https://www.twitch.tv/", "Twitch", 10],
  ["https://discord.com/", "Discord", 15],
  ["https://www.tiktok.com/", "TikTok", 18],
  ["https://www.spotify.com/", "Spotify", 10],
  ["https://www.microsoft.com/", "Microsoft", 8],
  ["https://www.apple.com/", "Apple", 6],
  ["https://www.ebay.com/", "eBay", 5],
  ["https://www.yahoo.com/", "Yahoo", 8],
  ["https://www.bing.com/", "Bing", 5],
  ["https://www.cnn.com/", "CNN", 6],
  ["https://www.nytimes.com/", "The New York Times", 5],
  ["https://www.google.com.br/", "Google Brasil", 40],
  ["https://www.uol.com.br/", "UOL", 15],
  ["https://www.globo.com/", "Globo", 18],
  ["https://www.mercadolivre.com.br/", "Mercado Livre", 12],
  ["https://www.magazineluiza.com.br/", "Magazine Luiza", 8],
  ["https://www.americanas.com.br/", "Americanas", 6],
  ["https://www.olx.com.br/", "OLX Brasil", 5],
  ["https://www.ifood.com.br/", "iFood", 10],
  ["https://www.nubank.com.br/", "Nubank", 8],
  ["https://www.itau.com.br/", "Itaú", 5],
  ["https://www.bradesco.com.br/", "Bradesco", 4],
  ["https://www.terra.com.br/", "Terra", 6],
  ["https://www.r7.com/", "R7", 5],
  ["https://www.cartola.globo.com/", "Cartola FC", 4],
  ["https://ge.globo.com/", "ge - Globo Esporte", 10],
  ["https://www.letras.mus.br/", "Letras", 5],
];

export type CookieSeed = {
  domain: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
};

export class ProfileManager {
  profile_dir: string;
  default_dir: string;

  constructor({ profileDir }: { profileDir: string }) {
    const profile_dir = profileDir;
    this.profile_dir = profile_dir;
    this.default_dir = join(profile_dir, "Default");
    mkdirSync(this.default_dir, { recursive: true });
  }

  seedHistory({
    sites = null,
    daysBack = 30,
  }: {
    sites?: HistorySite[] | null;
    daysBack?: number;
  } = {}): void {
    const history_sites = sites ?? DEFAULT_HISTORY_SITES;
    const history_db = join(this.default_dir, "History");
    const db = new Database(history_db);

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            title TEXT,
            visit_count INTEGER DEFAULT 0,
            typed_count INTEGER DEFAULT 0,
            last_visit_time INTEGER DEFAULT 0,
            hidden INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url INTEGER NOT NULL,
            visit_time INTEGER NOT NULL,
            from_visit INTEGER DEFAULT 0,
            transition INTEGER DEFAULT 0,
            segment_id INTEGER DEFAULT 0,
            visit_duration INTEGER DEFAULT 0,
            incremented_omnibox_typed_score INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS urls_url_index ON urls (url);
        CREATE INDEX IF NOT EXISTS visits_url_index ON visits (url);
        CREATE INDEX IF NOT EXISTS visits_time_index ON visits (visit_time);
      `);

      const insert_url = db.prepare(`
        INSERT OR REPLACE INTO urls (url, title, visit_count, typed_count, last_visit_time)
        VALUES (?, ?, ?, ?, ?)
      `);

      const insert_visit = db.prepare(`
        INSERT INTO visits (url, visit_time, transition, visit_duration)
        VALUES (?, ?, ?, ?)
      `);

      const now_seconds = Date.now() / 1_000;

      for (const [url, title, visit_count] of history_sites) {
        const visits = Math.max(1, visit_count + random_int(-5, 5));
        const last_visit_offset = Math.random() * daysBack * 24 * 3600;
        const last_visit = to_chrome_time(now_seconds - last_visit_offset);

        const result = insert_url.run(url, title, visits, Math.floor(visits / 3), last_visit);
        const url_id = Number(result.lastInsertRowid);

        for (let index = 0; index < visits; index += 1) {
          const visit_offset = Math.random() * daysBack * 24 * 3600;
          const visit_time = to_chrome_time(now_seconds - visit_offset);
          const visit_duration = random_int(10_000_000, 300_000_000);

          insert_visit.run(url_id, visit_time, 805306368, visit_duration);
        }
      }
    } finally {
      db.close();
    }
  }

  seedCookies({
    cookies = null,
  }: {
    cookies?: CookieSeed[] | null;
  } = {}): void {
    const generated_cookies = cookies ?? this._generate_default_cookies();
    const cookies_db = join(this.default_dir, "Cookies");
    const db = new Database(cookies_db);

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cookies (
            creation_utc INTEGER NOT NULL,
            host_key TEXT NOT NULL,
            top_frame_site_key TEXT NOT NULL,
            name TEXT NOT NULL,
            value TEXT NOT NULL,
            encrypted_value BLOB DEFAULT '',
            path TEXT NOT NULL,
            expires_utc INTEGER NOT NULL,
            is_secure INTEGER NOT NULL,
            is_httponly INTEGER NOT NULL,
            last_access_utc INTEGER NOT NULL,
            has_expires INTEGER NOT NULL DEFAULT 1,
            is_persistent INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 1,
            samesite INTEGER NOT NULL DEFAULT -1,
            source_scheme INTEGER NOT NULL DEFAULT 0,
            source_port INTEGER NOT NULL DEFAULT -1,
            last_update_utc INTEGER NOT NULL DEFAULT 0,
            source_type INTEGER NOT NULL DEFAULT 0,
            has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
            UNIQUE (host_key, top_frame_site_key, name, path, source_scheme, source_port)
        );
      `);

      const insert_cookie = db.prepare(`
        INSERT OR REPLACE INTO cookies (
            creation_utc, host_key, top_frame_site_key, name, value,
            path, expires_utc, is_secure, is_httponly, last_access_utc,
            has_expires, is_persistent, priority, samesite, source_scheme
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
      const one_year = 365n * 24n * 3600n * 1000000n;

      for (const cookie of generated_cookies) {
        const creation_utc = now - BigInt(random_int(0, 30 * 24 * 3600 * 1_000_000));

        insert_cookie.run(
          creation_utc,
          cookie.domain,
          "",
          cookie.name,
          cookie.value,
          cookie.path ?? "/",
          now + one_year,
          cookie.secure ? 1 : 0,
          cookie.httpOnly ? 1 : 0,
          now,
          1,
          1,
          1,
          -1,
          2,
        );
      }
    } finally {
      db.close();
    }
  }

  seedLocalStorage({
    data = null,
  }: {
    data?: Record<string, Record<string, string>> | null;
  } = {}): void {
    const local_storage_data = data ?? this._generate_default_local_storage();
    const local_storage_dir = join(this.default_dir, "Local Storage", "leveldb");
    mkdirSync(local_storage_dir, { recursive: true });
    void local_storage_data;
  }

  private _generate_default_cookies(): CookieSeed[] {
    const cookies: CookieSeed[] = [];

    cookies.push(
      { domain: ".google.com", name: "NID", value: this._random_hex(67), path: "/", secure: true, httpOnly: true },
      { domain: ".google.com", name: "1P_JAR", value: `2024-12-${String(random_int(1, 20)).padStart(2, "0")}-${String(random_int(0, 23)).padStart(2, "0")}`, path: "/", secure: true, httpOnly: false },
      { domain: ".google.com", name: "AEC", value: this._random_base64(76), path: "/", secure: true, httpOnly: true },
      { domain: ".google.com", name: "_GRECAPTCHA", value: `09${this._random_hex(126)}`, path: "/recaptcha", secure: true, httpOnly: true },
      { domain: ".google.com.br", name: "NID", value: this._random_hex(67), path: "/", secure: true, httpOnly: true },
    );

    cookies.push(
      { domain: ".youtube.com", name: "PREF", value: "f6=40000000&tz=America.Sao_Paulo&f5=30000", path: "/", secure: true, httpOnly: false },
      { domain: ".youtube.com", name: "VISITOR_INFO1_LIVE", value: this._random_base64(11), path: "/", secure: true, httpOnly: true },
      { domain: ".youtube.com", name: "YSC", value: this._random_base64(11), path: "/", secure: true, httpOnly: true },
    );

    cookies.push(
      { domain: ".facebook.com", name: "datr", value: this._random_base64(24), path: "/", secure: true, httpOnly: true },
      { domain: ".facebook.com", name: "sb", value: this._random_base64(24), path: "/", secure: true, httpOnly: true },
      { domain: ".facebook.com", name: "fr", value: this._random_hex(42), path: "/", secure: true, httpOnly: true },
    );

    cookies.push(
      { domain: ".twitter.com", name: "guest_id", value: `v1%3A${this._random_hex(19)}`, path: "/", secure: true, httpOnly: false },
      { domain: ".twitter.com", name: "ct0", value: this._random_hex(32), path: "/", secure: true, httpOnly: false },
      { domain: ".x.com", name: "guest_id", value: `v1%3A${this._random_hex(19)}`, path: "/", secure: true, httpOnly: false },
    );

    cookies.push(
      { domain: ".reddit.com", name: "session_tracker", value: this._random_base64(32), path: "/", secure: true, httpOnly: false },
      { domain: ".reddit.com", name: "csv", value: "2", path: "/", secure: true, httpOnly: false },
    );

    cookies.push(
      { domain: ".amazon.com", name: "session-id", value: `${random_int(100, 999)}-${random_int(1_000_000, 9_999_999)}-${random_int(1_000_000, 9_999_999)}`, path: "/", secure: true, httpOnly: false },
      { domain: ".amazon.com", name: "ubid-main", value: `${random_int(100, 999)}-${random_int(1_000_000, 9_999_999)}-${random_int(1_000_000, 9_999_999)}`, path: "/", secure: true, httpOnly: false },
      { domain: ".amazon.com.br", name: "session-id", value: `${random_int(100, 999)}-${random_int(1_000_000, 9_999_999)}-${random_int(1_000_000, 9_999_999)}`, path: "/", secure: true, httpOnly: false },
    );

    cookies.push(
      { domain: ".netflix.com", name: "memclid", value: this._random_hex(32), path: "/", secure: true, httpOnly: false },
      { domain: ".netflix.com", name: "flwssn", value: this._random_hex(32), path: "/", secure: true, httpOnly: false },
    );

    cookies.push(
      { domain: ".instagram.com", name: "csrftoken", value: this._random_hex(32), path: "/", secure: true, httpOnly: false },
      { domain: ".instagram.com", name: "mid", value: this._random_base64(27), path: "/", secure: true, httpOnly: false },
      { domain: ".instagram.com", name: "ig_did", value: this._random_hex(36), path: "/", secure: true, httpOnly: true },
    );

    cookies.push(
      { domain: ".tiktok.com", name: "ttwid", value: this._random_base64(60), path: "/", secure: true, httpOnly: true },
      { domain: ".tiktok.com", name: "tt_csrf_token", value: this._random_hex(16), path: "/", secure: true, httpOnly: false },
    );

    cookies.push(
      { domain: ".linkedin.com", name: "bcookie", value: `"v=2&${this._random_hex(32)}"`, path: "/", secure: true, httpOnly: false },
      { domain: ".linkedin.com", name: "bscookie", value: `"v=1&${this._random_hex(64)}"`, path: "/", secure: true, httpOnly: true },
    );

    cookies.push(
      { domain: ".mercadolivre.com.br", name: "_d2id", value: this._random_hex(36), path: "/", secure: true, httpOnly: false },
      { domain: ".globo.com", name: "GLBID", value: this._random_hex(32), path: "/", secure: true, httpOnly: true },
      { domain: ".uol.com.br", name: "uolId", value: this._random_hex(24), path: "/", secure: true, httpOnly: false },
    );

    return cookies;
  }

  private _random_hex(length: number): string {
    return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
  }

  private _random_base64(length: number): string {
    return randomBytes(length).toString("base64url").slice(0, length);
  }

  private _generate_default_local_storage(): Record<string, Record<string, string>> {
    return {
      "https://www.youtube.com": {
        "yt-player-volume": '{"data":"{\\"volume\\":100,\\"muted\\":false}","expiration":1735689600000,"creation":1703980800000}',
      },
      "https://www.google.com": {
        _gads_sync: "accepted",
      },
    };
  }
}

function random_int(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function to_chrome_time(unix_timestamp_seconds: number): bigint {
  return BigInt(Math.floor(unix_timestamp_seconds * 1_000_000)) + 11644473600000000n;
}