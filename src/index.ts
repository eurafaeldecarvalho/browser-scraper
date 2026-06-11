export {
  Browser,
  BrowserError,
  STEALTH_FLAGS,
  DEFAULT_WEBGL_VENDOR,
  DEFAULT_WEBGL_RENDERER,
} from "./core/browser";
export { Tab, Dialog, type WaitUntil } from "./core/tab";
export { Element } from "./core/element";
export { CDPClient, CDPError } from "./core/cdp-client";
export { Network, Request, Response } from "./core/network";
export { HumanMouse, getSharedMouse } from "./behavior/mouse";
export { Keyboard, deriveKey } from "./behavior/keyboard";
export { ProfileManager, DEFAULT_HISTORY_SITES } from "./stealth/profile";
export { ShadowRootAccessor } from "./shadow/shadow-root";
export { findChrome, getChromeVersion } from "./utils/chrome-finder";

export const __version__ = "0.4.0";