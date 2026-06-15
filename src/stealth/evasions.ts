// Defense-in-depth fingerprint patches injected as MAIN-world init scripts
// (Page.addScriptToEvaluateOnNewDocument) so they win the race against the
// page's own detection code. Every patch is:
//   * conditional — it only acts when the value is actually a headless tell, so
//     a correctly-configured Chrome keeps its NATIVE descriptors (over-patching
//     a value that was already fine is itself a tell);
//   * defensive — wrapped in try/catch so a hardened page can never break;
//   * toString-native — wrapped callables use an apply-trap Proxy, which V8
//     reports as "[native code]", matching the existing WebGL override.
//
// NOTE: deviceMemory is deliberately NOT patched. There is no CDP override for
// it (unlike Emulation.setHardwareConcurrencyOverride, which propagates to
// workers), so a main-world-only getter would MANUFACTURE a main-vs-worker
// mismatch — a stronger tell than the real low value — and rewriting worker
// sources to fix that would risk breaking the target's own workers.

export type EvasionOptions = {
  webdriver?: boolean;
  notifications?: boolean;
  screen?: { width: number; height: number } | null;
};

// Chrome's window chrome (tabs + omnibox + bookmarks bar) and a typical OS
// taskbar, used to derive a coherent window geometry: inner < outer <= avail <
// screen. Without this split a "maximized" window reads inner == outer (zero
// chrome) or outer > avail (overflows the work area) — impossible geometry.
const WINDOW_CHROME_HEIGHT = 88;
const TASKBAR_HEIGHT = 40;

export type ScreenLayout = {
  screenWidth: number;
  screenHeight: number;
  availWidth: number;
  availHeight: number;
  outerWidth: number;
  outerHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

// Derives a self-consistent maximized-window geometry from a monitor size.
// Shared by screenSource (window.screen.* / outer*) and the device-metrics
// override (inner viewport) so the two never contradict each other.
export function screenLayout(width: number, height: number): ScreenLayout {
  const availWidth = width;
  const availHeight = Math.max(0, height - TASKBAR_HEIGHT);
  const outerWidth = availWidth;
  const outerHeight = availHeight; // a maximized window fills the work area
  const viewportWidth = outerWidth;
  const viewportHeight = Math.max(0, outerHeight - WINDOW_CHROME_HEIGHT);
  return { screenWidth: width, screenHeight: height, availWidth, availHeight, outerWidth, outerHeight, viewportWidth, viewportHeight };
}

// navigator.webdriver must be present and === false (NEVER deleted, never
// undefined — absence is the tell on Chrome >= 89). Only overrides when the
// launch flag --disable-blink-features=AutomationControlled did not already
// make it false, so the native getter is preserved in the common case.
function webdriverSource(): string {
  return `
    (() => {
      try {
        if (navigator.webdriver === false) return;
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => false,
          configurable: true,
          enumerable: true,
        });
      } catch (_) {}
    })();
  `;
}

// Headless reports Notification.permission === 'denied' while a real (headful)
// Chrome reports 'default' and permissions.query({name:'notifications'}) returns
// the PermissionState 'prompt' — the mapping a detector verifies. We reconcile
// Notification.permission to 'default', and for the notifications query we call
// the REAL query and shadow only its `.state` (default => the valid
// PermissionState 'prompt'), preserving the genuine PermissionStatus prototype,
// name and addEventListener. The query wrapper is an apply-trap Proxy installed
// on Permissions.prototype (native location) so toString and the own-vs-proto
// shape both stay native.
function notificationsSource(): string {
  return `
    (() => {
      try {
        if (window.Notification && Notification.permission === 'denied') {
          Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
        }
        var P = window.Permissions;
        if (P && P.prototype && typeof P.prototype.query === 'function') {
          var native = P.prototype.query;
          var proxied = new Proxy(native, {
            apply: function (target, thisArg, args) {
              var result = Reflect.apply(target, thisArg, args);
              var desc = args && args[0];
              if (desc && desc.name === 'notifications') {
                return result.then(function (status) {
                  try {
                    Object.defineProperty(status, 'state', {
                      get: function () {
                        var np = (window.Notification && Notification.permission) || 'default';
                        return np === 'default' ? 'prompt' : np;
                      },
                      configurable: true,
                    });
                  } catch (_) {}
                  return status;
                });
              }
              return result;
            },
          });
          Object.defineProperty(P.prototype, 'query', { value: proxied, writable: true, enumerable: true, configurable: true });
        }
      } catch (_) {}
    })();
  `;
}

// Headless reports window.outerWidth/outerHeight === 0 and an inconsistent
// screen. Apply a self-consistent maximized-window geometry (inner < outer <=
// avail < screen) with a zero origin. The inner viewport is set separately via
// Emulation.setDeviceMetricsOverride using the SAME ScreenLayout.
function screenSource(width: number, height: number): string {
  const layout = screenLayout(width, height);
  return `
    (() => {
      try {
        const define = (obj, prop, val) => {
          try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (_) {}
        };
        define(window.screen, 'width', ${layout.screenWidth});
        define(window.screen, 'height', ${layout.screenHeight});
        define(window.screen, 'availWidth', ${layout.availWidth});
        define(window.screen, 'availHeight', ${layout.availHeight});
        define(window.screen, 'availLeft', 0);
        define(window.screen, 'availTop', 0);
        define(window, 'screenX', 0);
        define(window, 'screenY', 0);
        define(window, 'screenLeft', 0);
        define(window, 'screenTop', 0);
        // A maximized window: outer fills the work area, never overflows it.
        define(window, 'outerWidth', ${layout.outerWidth});
        define(window, 'outerHeight', ${layout.outerHeight});
      } catch (_) {}
    })();
  `;
}

// Concatenates the requested evasion init scripts into a single source blob,
// injected before any page script runs.
export function buildEvasionSource(options: EvasionOptions): string {
  const parts: string[] = [];

  if (options.webdriver !== false) {
    parts.push(webdriverSource());
  }
  if (options.notifications !== false) {
    parts.push(notificationsSource());
  }
  if (options.screen) {
    parts.push(screenSource(options.screen.width, options.screen.height));
  }

  return parts.join("\n");
}
