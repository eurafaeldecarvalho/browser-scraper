import { Browser, DEFAULT_WEBGL_VENDOR, DEFAULT_WEBGL_RENDERER } from "../src";

// Verifies the WebGL identity override used for GPU-less cloud hosts: the
// reported renderer changes to the spoofed value, and getParameter still reports
// as native code (so the override is not itself flagged as a tampered function).
async function main(): Promise<void> {
  const has_display = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = !has_display || ["1", "true", "yes"].includes((process.env.HEADLESS ?? "").toLowerCase());

  const browser = new Browser({
    headless,
    webglVendor: DEFAULT_WEBGL_VENDOR,
    webglRenderer: DEFAULT_WEBGL_RENDERER,
  });

  try {
    const tab = await browser.newTab();
    await tab.goto({ url: "https://example.com" });

    // The override patches the PAGE's main world (where detection scripts run),
    // not our isolated evaluate world. A <script> element appended to the DOM
    // always executes in the main world, so it reads what a detector would.
    await tab.evaluate({
      expression: `
        (() => {
          const s = document.createElement('script');
          s.textContent = \`
            try {
              const gl = document.createElement('canvas').getContext('webgl');
              const ext = gl.getExtension('WEBGL_debug_renderer_info');
              const root = document.documentElement;
              root.setAttribute('data-gl-vendor', gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
              root.setAttribute('data-gl-renderer', gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
              root.setAttribute('data-gl-native', /\\\\[native code\\\\]/.test(gl.getParameter.toString()) + '');
            } catch (err) {
              document.documentElement.setAttribute('data-gl-renderer', 'err:' + err.message);
            }
          \`;
          document.documentElement.appendChild(s);
          s.remove();
        })()
      `,
    });

    const parsed = {
      vendor: await tab.evaluate({ expression: "document.documentElement.getAttribute('data-gl-vendor')" }),
      renderer: await tab.evaluate({ expression: "document.documentElement.getAttribute('data-gl-renderer')" }),
      nativeLooking: (await tab.evaluate({ expression: "document.documentElement.getAttribute('data-gl-native')" })) === "true",
    };
    console.log("vendor:", parsed.vendor);
    console.log("renderer:", parsed.renderer);
    console.log("getParameter looks native:", parsed.nativeLooking);

    const ok =
      parsed.renderer === DEFAULT_WEBGL_RENDERER &&
      parsed.vendor === DEFAULT_WEBGL_VENDOR &&
      parsed.nativeLooking === true;

    console.log(ok ? "\nPASS: WebGL override applied and looks native" : "\nFAIL: WebGL override check failed");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
