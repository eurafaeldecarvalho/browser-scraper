import type { Tab } from "../core/tab";

// Default low-key warm-up itinerary. Loading these (especially Google) lets the
// servers MINT real, server-validated cookies (NID, and a genuine _GRECAPTCHA on
// reCAPTCHA-bearing pages) into a persistent profile — reputation that cannot be
// forged. Run once per identity behind its sticky residential/mobile IP.
const DEFAULT_WARMUP_URLS = [
  "https://www.google.com/",
  "https://www.youtube.com/",
  "https://www.wikipedia.org/",
];

// Drives a tab through a few real navigations with ambient cursor motion and
// dwell so the profile accrues genuine cookies/history. Best-effort: individual
// navigation failures are swallowed so one bad URL never aborts the warm-up.
export async function warmProfile(
  tab: Tab,
  {
    urls = DEFAULT_WARMUP_URLS,
    dwellMs = 4_000,
  }: { urls?: string[]; dwellMs?: number } = {},
): Promise<void> {
  for (const url of urls) {
    try {
      await tab.goto({ url, waitUntil: "domcontentloaded", timeout: 30_000 });
      await tab.mouse.idle({ durationMs: dwellMs });
      await tab.sleep({ milliseconds: 1_500 });
    } catch {
      // Skip a failed origin; the rest of the itinerary still warms the profile.
    }
  }
}
