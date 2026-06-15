import { setTimeout as delay } from "node:timers/promises";

import { CDPClient } from "../core/cdp-client";

export function bezierPoint({ t, points }: { t: number; points: Array<[number, number]> }): [number, number] {
  const n = points.length - 1;
  let x = 0;
  let y = 0;

  for (const [index, [px, py]] of points.entries()) {
    const binom = factorial(n) / (factorial(index) * factorial(n - index));
    const term = binom * t ** index * (1 - t) ** (n - index);
    x += px * term;
    y += py * term;
  }

  return [x, y];
}

export function generateControlPoints({
  start,
  end,
  deviation = 0.3,
}: {
  start: [number, number];
  end: [number, number];
  deviation?: number;
}): Array<[number, number]> {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.sqrt(dx * dx + dy * dy);

  let perp_x = 0;
  let perp_y = 1;

  if (distance > 0) {
    perp_x = -dy / distance;
    perp_y = dx / distance;
  }

  const num_controls = random_int(1, 2);
  const points: Array<[number, number]> = [start];

  for (let index = 0; index < num_controls; index += 1) {
    const t = (index + 1) / (num_controls + 1);
    const base_x = start[0] + dx * t;
    const base_y = start[1] + dy * t;
    const dev = (Math.random() * 2 - 1) * deviation * distance;
    points.push([base_x + perp_x * dev, base_y + perp_y * dev]);
  }

  points.push(end);
  return points;
}

const SHARED_MICE = new WeakMap<CDPClient, HumanMouse>();

// Returns one HumanMouse per CDP connection so the cursor position is
// continuous across interactions (a fresh instance per click would always
// start from 0,0, which is an obvious non-human pattern).
export function getSharedMouse(cdp: CDPClient): HumanMouse {
  let mouse = SHARED_MICE.get(cdp);
  if (!mouse) {
    mouse = new HumanMouse(cdp);
    SHARED_MICE.set(cdp, mouse);
  }

  return mouse;
}

export class HumanMouse {
  private _cdp: CDPClient;
  private _current_x = 0;
  private _current_y = 0;

  constructor(cdp: CDPClient) {
    this._cdp = cdp;
  }

  // Moves the cursor with a human-like neuromotor profile: a min-jerk velocity
  // curve (accelerate then decelerate, not a flat ease-out), distance-scaled
  // duration/step-count (Fitts' law), small in-flight tremor, occasional
  // hesitations, and — on longer moves — a ballistic OVERSHOOT past the target
  // followed by a short corrective sub-movement. Coordinates are emitted as
  // floats (no integer truncation) so the trajectory isn't quantized.
  async moveTo({
    x,
    y,
    duration = null,
    steps = null,
    deviation = 0.2,
    buttons = 0,
  }: {
    x: number;
    y: number;
    duration?: number | null;
    steps?: number | null;
    deviation?: number;
    buttons?: number;
  }): Promise<void> {
    const start: [number, number] = [this._current_x, this._current_y];
    const distance = Math.hypot(x - start[0], y - start[1]);

    if (distance < 1) {
      await this._emit_move(x, y, buttons);
      this._current_x = x;
      this._current_y = y;
      return;
    }

    // Fitts-like timing/granularity when not explicitly overridden.
    const move_duration = duration ?? clamp(80 + 110 * Math.log2(1 + distance / 40), 120, 1200);
    const move_steps = steps ?? Math.max(15, Math.min(80, Math.round(distance / 6)));

    // Ballistic overshoot on longer travels, then correct.
    const overshoots = distance > 120 && Math.random() < 0.5;
    let first_end: [number, number] = [x, y];
    if (overshoots) {
      const ux = (x - start[0]) / distance;
      const uy = (y - start[1]) / distance;
      const magnitude = random_between(4, 14);
      first_end = [
        x + ux * magnitude + random_between(-3, 3),
        y + uy * magnitude + random_between(-3, 3),
      ];
    }

    await this._glide(start, first_end, move_duration, move_steps, deviation, buttons);

    if (overshoots) {
      await this._glide(
        [this._current_x, this._current_y],
        [x, y],
        random_between(90, 170),
        Math.max(6, Math.round(move_steps * 0.3)),
        0.1,
        buttons,
      );
    }
  }

  private async _glide(
    start: [number, number],
    end: [number, number],
    duration: number,
    steps: number,
    deviation: number,
    buttons: number,
  ): Promise<void> {
    const control_points = generateControlPoints({ start, end, deviation });
    const step_delay = duration / steps;

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      // Min-jerk position profile: bell-shaped velocity (smooth accel + decel).
      const eased_t = t ** 3 * (10 - 15 * t + 6 * t * t);
      const [curve_x, curve_y] = bezierPoint({ t: eased_t, points: control_points });
      // Tremor peaks mid-flight and vanishes at the endpoints (a hand settles).
      const tremor = 0.7 * Math.sin(t * Math.PI);
      const px = curve_x + random_between(-tremor, tremor);
      const py = curve_y + random_between(-tremor, tremor);

      await this._emit_move(px, py, buttons);

      this._current_x = px;
      this._current_y = py;

      let wait = step_delay * random_between(0.7, 1.3);
      if (Math.random() < 0.05) {
        wait += random_between(20, 90); // occasional micro-hesitation
      }
      await delay(wait);
    }
  }

  private async _emit_move(x: number, y: number, buttons: number): Promise<void> {
    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      buttons,
    });
  }

  // Ambient, non-periodic cursor drift to mimic a hand resting on the mouse.
  // Useful BEFORE a token-minting call (e.g. grecaptcha.execute()), where a
  // total absence of prior pointer motion reads as a "blind execute".
  async idle({
    durationMs = 1500,
    bounds = null,
  }: {
    durationMs?: number;
    bounds?: { width: number; height: number } | null;
  } = {}): Promise<void> {
    const max_x = bounds?.width ?? 1920;
    const max_y = bounds?.height ?? 1080;
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      const target_x = clamp(this._current_x + random_between(-40, 40), 0, max_x);
      const target_y = clamp(this._current_y + random_between(-30, 30), 0, max_y);
      await this.moveTo({ x: target_x, y: target_y, duration: random_between(120, 400), deviation: 0.15 });
      // Heavy-tailed dwell: mostly short, occasionally long — never periodic.
      await delay(random_between(150, 700) * (1 + Math.random() * Math.random()));
    }
  }

  async click({
    x = null,
    y = null,
    button = "left",
    clickCount = 1,
  }: {
    x?: number | null;
    y?: number | null;
    button?: string;
    clickCount?: number;
  } = {}): Promise<void> {
    if (x !== null && y !== null) {
      await this.moveTo({ x, y });
    }

    const cx = x ?? this._current_x;
    const cy = y ?? this._current_y;
    const mask = button_mask(button);

    await delay(random_between(30, 90));

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: cx,
      y: cy,
      button,
      buttons: mask,
      clickCount,
    });

    await delay(random_between(40, 110));

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: cx,
      y: cy,
      button,
      buttons: 0,
      clickCount,
    });
  }

  async scroll({
    deltaX = 0,
    deltaY = 0,
    x = null,
    y = null,
  }: {
    deltaX?: number;
    deltaY?: number;
    x?: number | null;
    y?: number | null;
  } = {}): Promise<void> {
    const cx = x ?? this._current_x;
    const cy = y ?? this._current_y;
    let remaining_y = deltaY;
    let remaining_x = deltaX;

    while (Math.abs(remaining_y) > 20 || Math.abs(remaining_x) > 20) {
      let chunk_y = Math.trunc(remaining_y * random_between(0.2, 0.4));
      let chunk_x = Math.trunc(remaining_x * random_between(0.2, 0.4));

      if (chunk_y === 0 && remaining_y !== 0) {
        chunk_y = remaining_y;
      }

      if (chunk_x === 0 && remaining_x !== 0) {
        chunk_x = remaining_x;
      }

      await this._cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.trunc(cx),
        y: Math.trunc(cy),
        deltaX: chunk_x,
        deltaY: chunk_y,
      });

      remaining_y -= chunk_y;
      remaining_x -= chunk_x;
      await delay(random_between(20, 50));
    }

    if (remaining_y !== 0 || remaining_x !== 0) {
      await this._cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.trunc(cx),
        y: Math.trunc(cy),
        deltaX: remaining_x,
        deltaY: remaining_y,
      });
    }
  }

  get position(): [number, number] {
    return [this._current_x, this._current_y];
  }
}

function factorial(value: number): number {
  if (value <= 1) {
    return 1;
  }

  return value * factorial(value - 1);
}

function random_between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function random_int(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// MouseEvent.buttons bitmask (left=1, right=2, middle=4) so a held-button drag
// reports the pressed button while it moves, like a real pointer.
function button_mask(button: string): number {
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  return 1;
}