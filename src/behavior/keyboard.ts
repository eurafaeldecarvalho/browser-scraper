import { setTimeout as delay } from "node:timers/promises";

import { CDPClient } from "../core/cdp-client";
import { getSharedMouse } from "./mouse";

type KeyDescriptor = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
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
    return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), text: char };
  }

  if (char >= "0" && char <= "9") {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  }

  // Any other printable symbol: dispatch via text, keyCode best-effort.
  return { key: char, code: "", keyCode: char.charCodeAt(0), text: char };
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
        { type: "mouseMoved", x: Math.trunc(x), y: Math.trunc(y) },
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
      },
      this._session_id,
    );
  }

  // Types a string character-by-character with proper key events and
  // human-like, slightly jittered delays between keystrokes.
  async type(text: string, { humanLike = true }: { humanLike?: boolean } = {}): Promise<void> {
    await this._warm_input_pipeline();

    for (const char of text) {
      await this._press(char);

      if (humanLike) {
        let current_delay = random_between(50, 150);
        if (Math.random() < 0.1) {
          current_delay += random_between(100, 300);
        }
        await delay(current_delay);
      }
    }
  }
}

function random_between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
