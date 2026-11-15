import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Keyboard } from "../behavior/keyboard";
import { getSharedMouse } from "../behavior/mouse";
import { CDPClient, runUnguarded } from "./cdp-client";

export class Element {
  private _cdp: CDPClient;
  private _node_id: number;
  private _selector: string;
  private _session_id: string | null;
  private _iframe_offset: [number, number];
  private _object_id: string | null = null;
  private _backend_node_id: number | null = null;

  constructor(
    cdp: CDPClient,
    node_id: number,
    selector = "",
    session_id: string | null = null,
    iframe_offset: [number, number] | null = null,
    backend_node_id: number | null = null,
  ) {
    this._cdp = cdp;
    this._node_id = node_id;
    this._backend_node_id = backend_node_id;
    this._selector = selector;
    this._session_id = session_id;
    this._iframe_offset = iframe_offset ?? [0, 0];
  }

  // A nodeId dies whenever anyone calls DOM.getDocument on the session again
  // (every byRef / find does), so an Element kept across another lookup — the
  // text field fill_form presses Enter in after filling a select, a drag
  // source resolved before its target — would fail with "Could not find node
  // with given id". The backend id survives that; prefer it when known.
  private _node_params(): { backendNodeId: number } | { nodeId: number } {
    return this._backend_node_id ? { backendNodeId: this._backend_node_id } : { nodeId: this._node_id };
  }

  // For the few DOM methods that only take a nodeId.
  private async _live_node_id(): Promise<number> {
    if (!this._backend_node_id) {
      return this._node_id;
    }
    const pushed = await this._cdp
      .send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [this._backend_node_id] }, this._session_id)
      .catch(() => null);
    const node_id = Number(pushed?.nodeIds?.[0] ?? 0);
    if (node_id) {
      this._node_id = node_id;
    }
    return this._node_id;
  }

  private async _resolve_object(): Promise<string> {
    if (this._object_id) {
      return this._object_id;
    }

    const result = await this._cdp.send(
      "DOM.resolveNode",
      {
        ...this._node_params(),
      },
      this._session_id,
    );

    this._object_id = result.object?.objectId ?? null;
    if (!this._object_id) {
      throw new Error("Failed to resolve element object");
    }

    return this._object_id;
  }

  private async _get_box_model(): Promise<Record<string, any> | null> {
    try {
      const result = await this._cdp.send(
        "DOM.getBoxModel",
        {
          ...this._node_params(),
        },
        this._session_id,
      );

      return result.model ?? null;
    } catch {
      return null;
    }
  }

  async click({
    humanLike = true,
    removeNewTabTarget = false,
  }: {
    humanLike?: boolean;
    removeNewTabTarget?: boolean;
  } = {}): Promise<void> {
    if (removeNewTabTarget) {
      await this._remove_new_tab_target();
    }

    if (this._session_id) {
      await this._click_in_iframe(humanLike);
      return;
    }

    await this._click_normal(humanLike);
  }

  // Click/hover point in page coordinates. An element outside the viewport is
  // scrolled into view first (like a person scrolls to a button before
  // clicking it) — input dispatched at off-screen coordinates hits nothing.
  private async _resolve_click_position(): Promise<{ x: number; y: number }> {
    let position = await this._raw_click_position();
    const viewport = await this._viewport_size();
    const outside = (point: { x: number; y: number }): boolean =>
      viewport !== null && (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height);
    if (outside(position)) {
      await this.scrollIntoView();
      // Smooth scrolling takes a moment over long distances: wait until the
      // element stops moving.
      for (let attempt = 0; attempt < 10; attempt++) {
        const next = await this._raw_click_position();
        const settled = Math.abs(next.x - position.x) < 1 && Math.abs(next.y - position.y) < 1;
        position = next;
        if (settled && !outside(position)) {
          break;
        }
        await delay(120);
      }
    }
    return position;
  }

  private async _viewport_size(): Promise<{ width: number; height: number } | null> {
    try {
      const metrics = await this._cdp.send("Page.getLayoutMetrics");
      const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      return layout ? { width: Number(layout.clientWidth), height: Number(layout.clientHeight) } : null;
    } catch {
      return null;
    }
  }

  private async _raw_click_position(): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;

    try {
      const quads_result = await this._cdp.send(
        "DOM.getContentQuads",
        {
          ...this._node_params(),
        },
        this._session_id,
      );

      const quads = quads_result.quads ?? [];
      if (!quads.length || quads[0].length < 8) {
        throw new Error("Could not get content quads");
      }

      const quad = quads[0];
      x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    } catch (error) {
      let box = await this._get_box_model();
      if (!box) {
        await this.scrollIntoView();
        box = await this._get_box_model();
      }

      if (!box) {
        throw new Error(`Could not get element position: ${String(error)}`);
      }

      const content = box.content ?? [];
      if (content.length < 6) {
        throw new Error("Invalid box model");
      }

      x = (content[0] + content[2]) / 2;
      y = (content[1] + content[5]) / 2;
    }

    const [iframe_x, iframe_y] = this._iframe_offset;
    return {
      x: x + iframe_x,
      y: y + iframe_y,
    };
  }

  private async _remove_new_tab_target(): Promise<void> {
    const object_id = await this._resolve_object();

    await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function() {
            if (!(this instanceof Element)) {
              return;
            }

            const candidates = [this];
            const closestAnchor = this.closest('a[target], area[target]');
            const closestForm = this.closest('form[target]');

            if (closestAnchor) {
              candidates.push(closestAnchor);
            }

            if (closestForm) {
              candidates.push(closestForm);
            }

            if ('form' in this && this.form instanceof HTMLFormElement) {
              candidates.push(this.form);
            }

            for (const candidate of candidates) {
              candidate.removeAttribute('target');
              candidate.removeAttribute('formtarget');
            }
          }
        `,
      },
      this._session_id,
    );
  }

  private async _click_in_iframe(human_like = true): Promise<void> {
    const position = await this._resolve_click_position();
    let { x, y } = position;

    if (human_like) {
      const mouse = getSharedMouse(this._cdp);
      await mouse.click({
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return;
    }

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });

    // Release is cleanup of the press: it must go out even if the call was
    // abandoned meanwhile (a mousedown handler opened a dialog), or the page
    // is left with the button held down.
    await runUnguarded(() =>
      this._cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      }),
    );
  }

  private async _click_normal(human_like = true): Promise<void> {
    const position = await this._resolve_click_position();
    let { x, y } = position;

    if (human_like) {
      const mouse = getSharedMouse(this._cdp);
      await mouse.click({
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return;
    }

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });

    // Release is cleanup of the press: it must go out even if the call was
    // abandoned meanwhile (a mousedown handler opened a dialog), or the page
    // is left with the button held down.
    await runUnguarded(() =>
      this._cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      }),
    );
  }

  async type({
    text,
    humanLike = true,
    clear = false,
    typos = false,
  }: {
    text: string;
    humanLike?: boolean;
    clear?: boolean;
    // Inject occasional adjacent-key typos + self-correction (human-weighted by
    // behavioral scorers). OFF by default — opt in only where mid-type value
    // assertions won't break. See Keyboard.type.
    typos?: boolean;
  }): Promise<void> {
    await this.focus();

    if (clear) {
      const object_id = await this._resolve_object();
      await this._cdp.send(
        "Runtime.callFunctionOn",
        {
          objectId: object_id,
          functionDeclaration: `
            function() {
              if (!(this instanceof Element)) {
                return;
              }

              if ('value' in this) {
                this.value = '';
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }

              if (this.isContentEditable) {
                this.textContent = '';
                this.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          `,
        },
        this._session_id,
      );
    }

    // Let the focus settle before the first keystroke; otherwise the initial
    // keyDown can race ahead of focus and be dropped by the target element.
    await delay(40);

    const keyboard = new Keyboard(this._cdp, this._session_id);
    await keyboard.type(text, { humanLike, typos });
  }

  // Presses a single key (e.g. "Enter", "Tab", "ArrowDown") on this element
  // after focusing it, using real keyDown/keyUp events.
  async pressKey({ key }: { key: string }): Promise<void> {
    await this.focus();
    await delay(40);
    const keyboard = new Keyboard(this._cdp, this._session_id);
    await keyboard.press(key);
  }

  // Moves the (human-like) cursor over the element without clicking, firing the
  // mouseover/mousemove events that hover-gated UIs and bot checks look for.
  async hover(): Promise<void> {
    const position = await this._resolve_click_position();
    const mouse = getSharedMouse(this._cdp);
    await mouse.moveTo({ x: position.x, y: position.y });
  }

  async focus(): Promise<void> {
    await this._cdp.send(
      "DOM.focus",
      {
        ...this._node_params(),
      },
      this._session_id,
    );
  }

  async scrollIntoView(): Promise<void> {
    const object_id = await this._resolve_object();

    await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function() {
              this.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                  inline: 'center'
              });
          }
        `,
      },
      this._session_id,
    );

    await delay(300);
  }

  async text(): Promise<string> {
    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: "function() { return this.textContent; }",
        returnByValue: true,
      },
      this._session_id,
    );

    return String(result.result?.value ?? "");
  }

  async innerHtml(): Promise<string> {
    const result = await this._cdp.send(
      "DOM.getOuterHTML",
      {
        ...this._node_params(),
      },
      this._session_id,
    );

    return String(result.outerHTML ?? "");
  }

  async getAttribute({ name }: { name: string }): Promise<string | null> {
    const result = await this._cdp.send(
      "DOM.getAttributes",
      {
        nodeId: await this._live_node_id(),
      },
      this._session_id,
    );

    const attrs = (result.attributes ?? []) as string[];
    for (let index = 0; index < attrs.length; index += 2) {
      if (attrs[index] === name) {
        return attrs[index + 1] ?? null;
      }
    }

    return null;
  }

  async setAttribute({ name, value }: { name: string; value: string }): Promise<void> {
    await this._cdp.send(
      "DOM.setAttributeValue",
      {
        nodeId: await this._live_node_id(),
        name,
        value,
      },
      this._session_id,
    );
  }

  async isVisible(): Promise<boolean> {
    const box = await this._get_box_model();
    if (!box) {
      return false;
    }

    const content = box.content ?? [];
    if (content.length < 6) {
      return false;
    }

    const width = Math.abs(content[2] - content[0]);
    const height = Math.abs(content[5] - content[1]);
    return width > 0 && height > 0;
  }

  async isEnabled(): Promise<boolean> {
    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function() {
            if (!(this instanceof Element)) {
              return false;
            }

            const ariaDisabled = this.getAttribute('aria-disabled');
            if (ariaDisabled === 'true') {
              return false;
            }

            const ariaBusy = this.getAttribute('aria-busy');
            if (ariaBusy === 'true') {
              return false;
            }

            if ('disabled' in this && this.disabled) {
              return false;
            }

            return true;
          }
        `,
        returnByValue: true,
      },
      this._session_id,
    );

    return Boolean(result.result?.value);
  }

  async isReady(): Promise<boolean> {
    const isVisible = await this.isVisible();
    if (!isVisible) {
      return false;
    }

    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function() {
            if (!(this instanceof Element)) {
              return false;
            }

            if (!this.isConnected) {
              return false;
            }

            const style = getComputedStyle(this);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.visibility === 'collapse' ||
              style.pointerEvents === 'none'
            ) {
              return false;
            }

            const rect = this.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return false;
            }

            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const topElement = document.elementFromPoint(centerX, centerY);
            if (topElement && topElement !== this && !this.contains(topElement)) {
              return false;
            }

            const ariaDisabled = this.getAttribute('aria-disabled');
            if (ariaDisabled === 'true') {
              return false;
            }

            const ariaBusy = this.getAttribute('aria-busy');
            if (ariaBusy === 'true') {
              return false;
            }

            if ('disabled' in this && this.disabled) {
              return false;
            }

            return true;
          }
        `,
        returnByValue: true,
      },
      this._session_id,
    );

    return Boolean(result.result?.value);
  }

  // Returns the element's viewport rect ({x, y, width, height}) or null when
  // it has no layout box (detached or display:none).
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const box = await this._get_box_model();
    if (!box) {
      return null;
    }

    const content = box.content ?? [];
    if (content.length < 8) {
      return null;
    }

    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);

    return {
      x,
      y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
    };
  }

  async getProperty({ name }: { name: string }): Promise<any> {
    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `function() { return this[${JSON.stringify(name)}]; }`,
        returnByValue: true,
      },
      this._session_id,
    );

    return result.result?.value;
  }

  async isChecked(): Promise<boolean> {
    return Boolean(await this.getProperty({ name: "checked" }));
  }

  // Selects an <option> in a <select> by value (or by visible label) and fires
  // input/change so frameworks listening for the change react as they would to
  // a real choice. Returns the selected option's { value, label }, or null when
  // this is not a <select> or no option matches.
  async selectOption({ value, label }: { value?: string; label?: string }): Promise<{ value: string; label: string } | null> {
    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function(value, label) {
            if (!(this instanceof HTMLSelectElement)) {
              return null;
            }
            const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const options = Array.from(this.options);
            const option =
              (value != null && options.find((o) => o.value === value)) ||
              (label != null && (options.find((o) => norm(o.label) === norm(label)) || options.find((o) => norm(o.label).includes(norm(label))))) ||
              (value != null && options.find((o) => norm(o.label) === norm(value))) ||
              null;
            if (!option) {
              return null;
            }
            this.value = option.value;
            option.selected = true;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { value: option.value, label: option.label };
          }
        `,
        arguments: [{ value: value ?? null }, { value: label ?? null }],
        returnByValue: true,
      },
      this._session_id,
    );
    return result.result?.value ?? null;
  }

  // Calls a function with the element as `this` and returns its JSON result.
  async callFunction({ fn, args = [] }: { fn: string; args?: unknown[] }): Promise<any> {
    const object_id = await this._resolve_object();
    const result = await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      this._session_id,
    );
    if (result.exceptionDetails) {
      throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed"));
    }
    return result.result?.value;
  }

  // CDP session the element lives in (null = the page itself, else an OOPIF).
  get sessionId(): string | null {
    return this._session_id;
  }

  // Sets files on an <input type=file> via DOM.setFileInputFiles (the only way
  // to populate a file picker programmatically — the OS dialog can't be driven).
  async setInputFiles({ files }: { files: string[] }): Promise<void> {
    await this._cdp.send(
      "DOM.setFileInputFiles",
      {
        files,
        ...this._node_params(),
      },
      this._session_id,
    );
  }

  async screenshot({ path = null }: { path?: string | null } = {}): Promise<Buffer | null> {
    const box = await this.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      return null;
    }

    // Out-of-process iframe boxes are relative to the frame: shift them into
    // page coordinates, and capture on the page session.
    const [offset_x, offset_y] = this._iframe_offset;
    const result = await this._cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x + offset_x, y: box.y + offset_y, width: box.width, height: box.height, scale: 1 },
      captureBeyondViewport: true,
    });

    const data = Buffer.from(String(result.data ?? ""), "base64");
    if (path) {
      await writeFile(path, data);
    }

    return data;
  }

  get nodeId(): number {
    return this._node_id;
  }

  get selector(): string {
    return this._selector;
  }
}