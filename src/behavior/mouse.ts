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

  async moveTo({
    x,
    y,
    duration = 500,
    steps = 50,
    deviation = 0.2,
  }: {
    x: number;
    y: number;
    duration?: number;
    steps?: number;
    deviation?: number;
  }): Promise<void> {
    const start: [number, number] = [this._current_x, this._current_y];
    const end: [number, number] = [x, y];
    const control_points = generateControlPoints({ start, end, deviation });
    const step_delay = duration / steps;

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const eased_t = 1 - (1 - t) ** 3;
      const [curve_x, curve_y] = bezierPoint({ t: eased_t, points: control_points });
      const jitter = 0.5;
      const px = curve_x + random_between(-jitter, jitter);
      const py = curve_y + random_between(-jitter, jitter);

      await this._cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.trunc(px),
        y: Math.trunc(py),
      });

      this._current_x = px;
      this._current_y = py;
      await delay(step_delay * random_between(0.8, 1.2));
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

    await delay(random_between(30, 80));

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.trunc(cx),
      y: Math.trunc(cy),
      button,
      clickCount,
    });

    await delay(random_between(50, 120));

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.trunc(cx),
      y: Math.trunc(cy),
      button,
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