// Central fingerprint derivation. Everything that must stay mutually consistent
// — UA string, Client-Hints metadata, WebGL identity, architecture, geo — is
// derived HERE from one resolved User-Agent so the layers can never be set
// independently and contradict each other. A cross-layer mismatch (e.g. a
// Windows D3D11 GPU under a Linux UA) is the single highest-signal bot tell.

export type PersonaPlatform = "Windows" | "macOS" | "Linux" | "Android";

export type WebGLIdentity = { vendor: string; renderer: string };

export type GeoProfile = {
  timezone: string;
  locale: string;
  acceptLanguage: string;
};

// Detects the OS a User-Agent claims. This is the SAME platform that Client
// Hints and the WebGL default must agree with.
export function platformFromUA(userAgent: string): PersonaPlatform {
  if (userAgent.includes("Android")) {
    return "Android";
  }
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X")) {
    return "macOS";
  }
  if (userAgent.includes("Windows")) {
    return "Windows";
  }
  return "Linux";
}

// Believable, OS-COHERENT WebGL identities. The renderer backend token must
// match the OS: Direct3D11/D3D11 is Windows-only; Linux uses an OpenGL/Vulkan
// ANGLE backend over Mesa; macOS uses the Metal backend. Emitting a D3D11 string
// on a Linux UA is an impossible combination that DataDome Picasso hard-blocks.
//
// NOTE: on a GPU-less host the *real* pixel hash / extension list still come
// from SwiftShader, so a discrete-GPU string here is only safe for soft targets.
// For hard targets either drop the spoof (coherent software identity) or run a
// real GPU (EC2 g4dn/g5). See README "GPU / WebGL".
export function defaultWebglForPlatform(platform: PersonaPlatform): WebGLIdentity {
  switch (platform) {
    case "Windows":
      return {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      };
    case "macOS":
      return {
        vendor: "Google Inc. (Apple)",
        renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
      };
    case "Android":
      return {
        vendor: "Google Inc. (Qualcomm)",
        renderer: "ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)",
      };
    case "Linux":
    default:
      // Coherent Linux software/integrated identity. On a GPU-less cloud host
      // this blends with the ~2.7% of real users on VMs/WSL2 rather than
      // claiming hardware the pixel hash can't back up.
      return {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1) (0x00009A60), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
      };
  }
}

// CH platformVersion that real Chrome reports. Linux is genuinely EMPTY; macOS
// reports a real OS version (NOT the UA-string-capped 10.15.7); Windows 11 maps
// to "15.0.0" in the UA-CH model.
function platformVersionFor(platform: PersonaPlatform): string {
  switch (platform) {
    case "Windows":
      return "15.0.0";
    case "macOS":
      return "14.6.1";
    case "Android":
      return "13.0.0";
    case "Linux":
    default:
      return "";
  }
}

// CH architecture/bitness real Chrome reports. Apple Silicon reports "arm" even
// though the macOS UA always says "Intel". Mobile reports empty strings. Desktop
// x86-64 is "x86"/"64"; arm64 Linux (Graviton/Lambda-arm) is "arm"/"64".
function archFor(userAgent: string, platform: PersonaPlatform): { architecture: string; bitness: string } {
  if (platform === "Android") {
    return { architecture: "", bitness: "" };
  }
  if (platform === "macOS") {
    return { architecture: "arm", bitness: "64" };
  }
  if (/aarch64|arm64|armv8/i.test(userAgent)) {
    return { architecture: "arm", bitness: "64" };
  }
  return { architecture: "x86", bitness: "64" };
}

function chPlatformName(platform: PersonaPlatform): string {
  switch (platform) {
    case "Windows":
      return "Windows";
    case "macOS":
      return "macOS";
    case "Android":
      return "Android";
    case "Linux":
    default:
      return "Linux";
  }
}

// Builds Client-Hints metadata consistent with the given UA so that
// navigator.userAgentData and the sec-ch-ua-* headers agree with it.
//
//  - fullVersion (e.g. "120.0.6099.109") comes from Chrome's /json/version
//    "Browser" field. Real Chrome's fullVersionList carries the COMPLETE 4-part
//    build; the reduced UA only carries "X.0.0.0", so a fullVersionList of
//    "X.0.0.0" is an impossible build number and a tell. We thread the real
//    build in. The GREASE ("Not?A_Brand") entry legitimately is "8.0.0.0".
export function buildUserAgentMetadata(
  userAgent: string,
  fullVersion: string | null = null,
): Record<string, unknown> {
  const major = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "120";
  const platform = platformFromUA(userAgent);
  const { architecture, bitness } = archFor(userAgent, platform);

  // Real 4-part build for the actual Chromium brands; fall back to a plausible
  // build only when /json/version did not yield one, or when it disagrees with
  // the UA major (e.g. a caller-overridden UA) which would itself be a mismatch.
  const real_full =
    fullVersion && /^\d+\.\d+\.\d+\.\d+$/.test(fullVersion) && fullVersion.split(".")[0] === major
      ? fullVersion
      : `${major}.0.0.0`;

  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not?A_Brand", version: "8" },
  ];

  const full_version_list = [
    { brand: "Chromium", version: real_full },
    { brand: "Google Chrome", version: real_full },
    { brand: "Not?A_Brand", version: "8.0.0.0" },
  ];

  let model = "";
  if (platform === "Android") {
    model = userAgent.match(/;\s([^;)]+)\sBuild\//)?.[1]?.trim() ?? "Pixel 7";
  }

  return {
    brands,
    fullVersionList: full_version_list,
    platform: chPlatformName(platform),
    platformVersion: platformVersionFor(platform),
    architecture,
    bitness,
    model,
    mobile: platform === "Android",
    wow64: false,
  };
}

// Minimal country → geo map so a proxy exit can drive timezone + locale +
// Accept-Language together (IP-geo that disagrees with Intl timezone is a hard
// tell). acceptLanguage is a PLAIN comma list with NO q-values on purpose:
// Chrome derives navigator.languages from this exact string and does NOT strip
// ";q=0.9", so a q-valued entry would surface as a literal "pt;q=0.9" language —
// a token no real browser shows. Extend as needed.
const GEO_BY_COUNTRY: Record<string, GeoProfile> = {
  BR: { timezone: "America/Sao_Paulo", locale: "pt-BR", acceptLanguage: "pt-BR,pt,en" },
  US: { timezone: "America/New_York", locale: "en-US", acceptLanguage: "en-US,en" },
  GB: { timezone: "Europe/London", locale: "en-GB", acceptLanguage: "en-GB,en" },
  DE: { timezone: "Europe/Berlin", locale: "de-DE", acceptLanguage: "de-DE,de,en" },
  FR: { timezone: "Europe/Paris", locale: "fr-FR", acceptLanguage: "fr-FR,fr,en" },
  ES: { timezone: "Europe/Madrid", locale: "es-ES", acceptLanguage: "es-ES,es,en" },
  PT: { timezone: "Europe/Lisbon", locale: "pt-PT", acceptLanguage: "pt-PT,pt,en" },
  IT: { timezone: "Europe/Rome", locale: "it-IT", acceptLanguage: "it-IT,it,en" },
  NL: { timezone: "Europe/Amsterdam", locale: "nl-NL", acceptLanguage: "nl-NL,nl,en" },
  CA: { timezone: "America/Toronto", locale: "en-CA", acceptLanguage: "en-CA,en,fr-CA" },
  MX: { timezone: "America/Mexico_City", locale: "es-MX", acceptLanguage: "es-MX,es,en" },
  AR: { timezone: "America/Argentina/Buenos_Aires", locale: "es-AR", acceptLanguage: "es-AR,es,en" },
  AU: { timezone: "Australia/Sydney", locale: "en-AU", acceptLanguage: "en-AU,en" },
  JP: { timezone: "Asia/Tokyo", locale: "ja-JP", acceptLanguage: "ja-JP,ja,en" },
  IN: { timezone: "Asia/Kolkata", locale: "en-IN", acceptLanguage: "en-IN,en,hi" },
};

// Resolves a 2-letter country code (case-insensitive) to a coherent geo profile,
// or null for an unknown code (the caller warns rather than silently applying a
// wrong region — applying a default would mismatch the proxy exit).
export function geoForCountry(country: string): GeoProfile | null {
  return GEO_BY_COUNTRY[country.trim().toUpperCase()] ?? null;
}
