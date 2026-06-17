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
  // chrome-headless-shell only: shim window.chrome and a non-zero
  // navigator.connection.rtt, both present on real headful Chrome but missing in
  // the shell binary. Conditional (no-op when already present/non-zero).
  windowChrome?: boolean;
  connection?: boolean;
  // OPT-IN: override MouseEvent.screenX/screenY to clientX+x / clientY+y to
  // counter the CDP screenX==clientX artifact. Verify on your binary first.
  screenCoordOffset?: { x: number; y: number } | null;
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

// Shell-only / opt-in shims for surfaces chrome-headless-shell lacks but a real
// headful Chrome exposes natively (window.chrome; a non-zero
// navigator.connection.rtt) plus the opt-in CDP screenX/screenY fix. All run in
// ONE IIFE sharing a native-toString helper, so every fabricated callable/getter
// reports "function … { [native code] }" and can't be unmasked by a direct
// Function.prototype.toString check (the same discipline the WebGL override uses).
// Descriptors are written to MATCH real Chrome: window.chrome is an enumerable,
// writable, CONFIGURABLE own data property (a non-configurable descriptor is
// itself a spoof signature — native window/navigator props are configurable);
// connection/MouseEvent values are accessors on the PROTOTYPE, where real Chrome's
// WebIDL getters live (an own accessor on the instance is an own-vs-prototype
// tell). KNOWN LIMITATION: a detector that pulls a pristine
// Function.prototype.toString from a fresh iframe can still unmask a fabricated fn
// — inherent to any JS-level shim; these are soft-target aids only (see
// docs/antibot-and-captcha-research.md). Each block is conditional and no-ops when
// the value is already real, so a full/headful Chrome is never touched.
function coherentShimsSource(opts: {
  windowChrome?: boolean;
  connection?: boolean;
  screenCoordOffset?: { x: number; y: number } | null;
}): string {
  const blocks: string[] = [];

  if (opts.windowChrome) {
    blocks.push(`
        // window.chrome — only when genuinely absent (never overwrite a real one).
        if (!(window.chrome && window.chrome.runtime)) {
          const chrome = window.chrome || {};
          if (!chrome.runtime) {
            chrome.runtime = {
              connect: nf('connect', function () {}),
              sendMessage: nf('sendMessage', function () {}),
              OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
              OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
              PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
              PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
              RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
            };
          }
          if (!chrome.app) {
            chrome.app = {
              isInstalled: false,
              InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
              RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
              getDetails: nf('getDetails', function () { return null; }),
              getIsInstalled: nf('getIsInstalled', function () { return false; }),
            };
          }
          if (!chrome.csi) chrome.csi = nf('csi', function () { return { onloadT: Date.now(), startE: Date.now(), pageT: 0, tran: 15 }; });
          if (!chrome.loadTimes) chrome.loadTimes = nf('loadTimes', function () { return {}; });
          Object.defineProperty(window, 'chrome', { value: chrome, writable: true, enumerable: true, configurable: true });
        }`);
  }

  if (opts.connection) {
    blocks.push(`
        // navigator.connection: shell reports rtt===0. Patch on the PROTOTYPE with
        // native-looking getters, only when rtt is the headless 0 default. rtt is a
        // 25ms multiple like real Chrome; effectiveType/downlink only if missing.
        {
          const c = navigator.connection;
          if (c && c.rtt === 0) {
            const proto = Object.getPrototypeOf(c) || c;
            ng(proto, 'rtt', [50, 75, 100][Math.floor(Math.random() * 3)]);
            if (!c.effectiveType) ng(proto, 'effectiveType', '4g');
            if (!c.downlink) ng(proto, 'downlink', 10);
          }
        }`);
  }

  if (opts.screenCoordOffset) {
    blocks.push(`
        // MouseEvent.screenX/screenY = clientX+sx / clientY+sy (opt-in).
        {
          const sx = ${JSON.stringify(opts.screenCoordOffset.x)};
          const sy = ${JSON.stringify(opts.screenCoordOffset.y)};
          ng(MouseEvent.prototype, 'screenX', null, function () { return (this.clientX || 0) + sx; });
          ng(MouseEvent.prototype, 'screenY', null, function () { return (this.clientY || 0) + sy; });
        }`);
  }

  if (!blocks.length) {
    return "";
  }

  return `
    (() => {
      try {
        const reg = new WeakSet();
        const origToString = Function.prototype.toString;
        const proxyToString = new Proxy(origToString, {
          apply(target, thisArg, args) {
            if (reg.has(thisArg)) {
              return 'function ' + ((thisArg && thisArg.name) || '') + '() { [native code] }';
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        reg.add(proxyToString);
        try { Function.prototype.toString = proxyToString; } catch (_) {}
        // nf: mark a fabricated FUNCTION native (also sets its .name).
        const nf = (name, fn) => {
          try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
          reg.add(fn);
          return fn;
        };
        // ng: define a native-looking GETTER on a prototype (fixed val, or an
        // explicit getter fn). Getter name is "get <prop>" to match native.
        const ng = (proto, prop, val, getter) => {
          try {
            const g = getter || function () { return val; };
            try { Object.defineProperty(g, 'name', { value: 'get ' + prop, configurable: true }); } catch (_) {}
            reg.add(g);
            Object.defineProperty(proto, prop, { get: g, enumerable: true, configurable: true });
          } catch (_) {}
        };
        ${blocks.join("\n")}
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
  // Shell-only / opt-in shims, in one IIFE sharing the native-toString helper.
  const shimSource = coherentShimsSource({
    windowChrome: options.windowChrome,
    connection: options.connection,
    screenCoordOffset: options.screenCoordOffset ?? null,
  });
  if (shimSource.trim()) {
    parts.push(shimSource);
  }

  return parts.join("\n");
}
