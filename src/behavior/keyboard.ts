import { setTimeout as delay } from "node:timers/promises";

import { CDPClient } from "../core/cdp-client";
import { getSharedMouse } from "./mouse";

type KeyDescriptor = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  shifted?: boolean;
};

// Minimal US-layout table for non-printable / named keys. Printable characters
// are derived on the fly by deriveKey(). Names match the CDP/Web "key" values.
const NAMED_KEYS: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};

// US-layout virtual-key codes for printable symbols, mirroring Puppeteer's
// USKeyboardLayout. Deriving keyCode from charCodeAt is WRONG for symbols:
// '('.charCodeAt(0) === 40 === ArrowDown's keyCode, '.' === 46 === Delete,
// '&' === 38 === ArrowUp — pages that read event.keyCode (autocompletes,
// dropdown menus) interpret those keystrokes as navigation and corrupt the
// typed value. keyCode must be the VK code of the PHYSICAL key instead.
const SYMBOL_KEYS: Record<string, { code: string; keyCode: number; shifted?: boolean }> = {
  ";": { code: "Semicolon", keyCode: 186 },
  "=": { code: "Equal", keyCode: 187 },
  ",": { code: "Comma", keyCode: 188 },
  "-": { code: "Minus", keyCode: 189 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "\\": { code: "Backslash", keyCode: 220 },
  "]": { code: "BracketRight", keyCode: 221 },
  "'": { code: "Quote", keyCode: 222 },
  ")": { code: "Digit0", keyCode: 48, shifted: true },
  "!": { code: "Digit1", keyCode: 49, shifted: true },
  "@": { code: "Digit2", keyCode: 50, shifted: true },
  "#": { code: "Digit3", keyCode: 51, shifted: true },
  $: { code: "Digit4", keyCode: 52, shifted: true },
  "%": { code: "Digit5", keyCode: 53, shifted: true },
  "^": { code: "Digit6", keyCode: 54, shifted: true },
  "&": { code: "Digit7", keyCode: 55, shifted: true },
  "*": { code: "Digit8", keyCode: 56, shifted: true },
  "(": { code: "Digit9", keyCode: 57, shifted: true },
  ":": { code: "Semicolon", keyCode: 186, shifted: true },
  "+": { code: "Equal", keyCode: 187, shifted: true },
  "<": { code: "Comma", keyCode: 188, shifted: true },
  _: { code: "Minus", keyCode: 189, shifted: true },
  ">": { code: "Period", keyCode: 190, shifted: true },
  "?": { code: "Slash", keyCode: 191, shifted: true },
  "~": { code: "Backquote", keyCode: 192, shifted: true },
  "{": { code: "BracketLeft", keyCode: 219, shifted: true },
  "|": { code: "Backslash", keyCode: 220, shifted: true },
  "}": { code: "BracketRight", keyCode: 221, shifted: true },
  '"': { code: "Quote", keyCode: 222, shifted: true },
  " ": { code: "Space", keyCode: 32 },
};

// Resolves a single printable character or a named key into a full descriptor
// with the code/keyCode that a real keyboard would report.
export function deriveKey(key: string): KeyDescriptor {
  if (NAMED_KEYS[key]) {
    return NAMED_KEYS[key];
  }

  if (key.length !== 1) {
    return { key, code: "", keyCode: 0, text: key };
  }

  const char = key;
  const upper = char.toUpperCase();

  if (char >= "a" && char <= "z") {
    return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
  }

  if (char >= "A" && char <= "Z") {
    return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), text: char, shifted: true };
  }

  if (char >= "0" && char <= "9") {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  }

  const symbol = SYMBOL_KEYS[char];
  if (symbol) {
    return { key: char, code: symbol.code, keyCode: symbol.keyCode, text: char, shifted: symbol.shifted };
  }

  // Unknown printable char (accents, unicode): dispatch via text with keyCode 0.
  // NEVER fall back to charCodeAt — it collides with navigation-key codes.
  return { key: char, code: "", keyCode: 0, text: char };
}

export class Keyboard {
  private _cdp: CDPClient;
  private _session_id: string | null;

  constructor(cdp: CDPClient, session_id: string | null = null) {
    this._cdp = cdp;
    this._session_id = session_id;
  }

  // Chrome drops the very first Input event dispatched to a freshly loaded
  // renderer before its input pipeline is ready. A throwaway mouseMoved at the
  // cursor's current position primes it so the first real keystroke lands.
  private async _warm_input_pipeline(): Promise<void> {
    try {
      const [x, y] = getSharedMouse(this._cdp).position;
      await this._cdp.send(
        "Input.dispatchMouseEvent",
        // Emit the raw float position (no truncation) to match HumanMouse's
        // float emission, so the warm pulse doesn't back-jump the cursor.
        { type: "mouseMoved", x, y },
        this._session_id,
      );
    } catch {
    }
  }

  // Presses and releases one key (named like "Enter" or a single char),
  // dispatching proper keyDown/keyUp pairs with realistic codes.
  async press(key: string): Promise<void> {
    await this._warm_input_pipeline();
    await this._press(key);
  }

  private async _press(key: string): Promise<void> {
    await this.down(key);
    await delay(random_between(20, 60));
    await this.up(key);
  }

  async down(key: string): Promise<void> {
    const descriptor = deriveKey(key);
    const is_printable = Boolean(descriptor.text);

    await this._cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: is_printable ? "keyDown" : "rawKeyDown",
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.keyCode,
        nativeVirtualKeyCode: descriptor.keyCode,
        modifiers: descriptor.shifted ? 8 : 0,
        ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
      },
      this._session_id,
    );
  }

  async up(key: string): Promise<void> {
    const descriptor = deriveKey(key);

    await this._cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.keyCode,
        nativeVirtualKeyCode: descriptor.keyCode,
        modifiers: descriptor.shifted ? 8 : 0,
      },
      this._session_id,
    );
  }

  // Types a string with realistic per-keystroke dynamics: lognormal dwell (key
  // hold) and flight (inter-key) times rather than uniform jitter, occasional
  // longer pauses, and intermittent key ROLLOVER — pressing the next key before
  // releasing the current one, which is physically real for fast typists and
  // structurally impossible with a strictly sequential down→up loop.
  async type(
    text: string,
    { humanLike = true, typos = false }: { humanLike?: boolean; typos?: boolean } = {},
  ): Promise<void> {
    await this._warm_input_pipeline();

    const chars = [...text];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      const next = chars[index + 1];

      if (!humanLike) {
        await this._press(char);
        continue;
      }

      // Occasional realistic typo on a letter: hit an adjacent QWERTY key, pause
      // as if noticing, Backspace, then type the right one. Behavioral scorers
      // (reCAPTCHA v3) weight self-correction as strongly human. OFF by default —
      // a scraper that asserts exact field values mid-type must opt in.
      if (typos && Math.random() < 0.03) {
        const wrong = adjacent_key(char);
        if (wrong) {
          await this._press(wrong);
          await delay(lognormal_ms(170, 0.5, 80, 420));
          await this._press("Backspace");
          await delay(lognormal_ms(90, 0.4, 40, 200));
        }
      }

      const dwell = lognormal_ms(70, 0.5, 25, 180);
      const can_roll = Boolean(next) && is_rollable(char) && is_rollable(next) && Math.random() < 0.12;

      await this.down(char);
      await delay(dwell);

      if (can_roll) {
        // Overlap: begin the next key before lifting the current one.
        await this.down(next);
        await this.up(char);
        await delay(lognormal_ms(45, 0.5, 15, 120));
        await this.up(next);
        index += 1; // consumed `next`
      } else {
        await this.up(char);
      }

      let flight = lognormal_ms(110, 0.45, 40, 260);
      if (Math.random() < 0.08) {
        flight += random_between(120, 350); // rare longer pause (thinking)
      }
      await delay(flight);
    }
  }
}

function random_between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Samples a lognormal-distributed delay in ms (median-centered), clamped to a
// plausible range. Human keystroke dwell/flight times are right-skewed, which a
// uniform distribution never reproduces.
function lognormal_ms(median: number, sigma: number, min: number, max: number): number {
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = Math.exp(Math.log(median) + sigma * z);
  return Math.max(min, Math.min(max, value));
}

// Rollover is only attempted between two simple unshifted keys (lowercase
// letters / digits) so overlapping presses never tangle the Shift modifier.
function is_rollable(char: string): boolean {
  return /^[a-z0-9]$/.test(char);
}

// Approximate QWERTY physical neighbours, for realistic typos. Only letters are
// covered; anything else returns null (no typo injected). Case is preserved.
const QWERTY_NEIGHBORS: Record<string, string> = {
  q: "wa",
  w: "qes",
  e: "wrd",
  r: "etf",
  t: "ryg",
  y: "tuh",
  u: "yij",
  i: "uok",
  o: "ipl",
  p: "ol",
  a: "qsz",
  s: "awdz",
  d: "sefcx",
  f: "drgvc",
  g: "ftyhbv",
  h: "gyujnb",
  j: "huiknm",
  k: "jiolm",
  l: "kop",
  z: "asx",
  x: "zsdc",
  c: "xdfv",
  v: "cfgb",
  b: "vghn",
  n: "bhjm",
  m: "njk",
};

// Picks a plausible adjacent-key misstroke for a letter (preserving case), or
// null for non-letters / unmapped chars (so no typo is injected there).
function adjacent_key(char: string): string | null {
  const lower = char.toLowerCase();
  if (!/^[a-z]$/.test(lower)) {
    return null;
  }
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors) {
    return null;
  }
  const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
  return char === char.toUpperCase() ? pick.toUpperCase() : pick;
}
