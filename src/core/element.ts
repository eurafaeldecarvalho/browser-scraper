import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { Keyboard } from "../behavior/keyboard";
import { getSharedMouse } from "../behavior/mouse";
import { CDPClient } from "./cdp-client";

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
  ) {
    this._cdp = cdp;
    this._node_id = node_id;
    this._selector = selector;
    this._session_id = session_id;
    this._iframe_offset = iframe_offset ?? [0, 0];
  }

  private async _resolve_object(): Promise<string> {
    if (this._object_id) {
      return this._object_id;
    }

    const result = await this._cdp.send(
      "DOM.resolveNode",
      {
        nodeId: this._node_id,
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
          nodeId: this._node_id,
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

  private async _resolve_click_position(): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;

    try {
      const quads_result = await this._cdp.send(
        "DOM.getContentQuads",
        {
          nodeId: this._node_id,
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

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
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

    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async type({
    text,
    humanLike = true,
    clear = false,
  }: {
    text: string;
    humanLike?: boolean;
    clear?: boolean;
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
    await keyboard.type(text, { humanLike });
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
        nodeId: this._node_id,
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
        nodeId: this._node_id,
      },
      this._session_id,
    );

    return String(result.outerHTML ?? "");
  }

  async getAttribute({ name }: { name: string }): Promise<string | null> {
    const result = await this._cdp.send(
      "DOM.getAttributes",
      {
        nodeId: this._node_id,
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
        nodeId: this._node_id,
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

  // Selects an <option> in a <select> by value and fires input/change so
  // frameworks listening for the change react as they would to a real choice.
  async selectOption({ value }: { value: string }): Promise<void> {
    const object_id = await this._resolve_object();
    await this._cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object_id,
        functionDeclaration: `
          function(value) {
            if (!(this instanceof HTMLSelectElement)) {
              return;
            }
            this.value = value;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }
        `,
        arguments: [{ value }],
      },
      this._session_id,
    );
  }

  // Sets files on an <input type=file> via DOM.setFileInputFiles (the only way
  // to populate a file picker programmatically — the OS dialog can't be driven).
  async setInputFiles({ files }: { files: string[] }): Promise<void> {
    await this._cdp.send(
      "DOM.setFileInputFiles",
      {
        files,
        nodeId: this._node_id,
      },
      this._session_id,
    );
  }

  async screenshot({ path = null }: { path?: string | null } = {}): Promise<Buffer | null> {
    const box = await this.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      return null;
    }

    const result = await this._cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
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