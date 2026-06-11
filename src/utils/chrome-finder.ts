import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

export function findChrome(): string | null {
  const system = platform();

  if (system === "win32") {
    return find_chrome_windows();
  }

  if (system === "darwin") {
    return find_chrome_macos();
  }

  return find_chrome_linux();
}

function find_chrome_windows(): string | null {
  const paths = [
    join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Chromium", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];

  return paths.find((current_path) => existsSync(current_path)) ?? null;
}

function find_chrome_macos(): string | null {
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ];

  return paths.find((current_path) => existsSync(current_path)) ?? null;
}

function find_chrome_linux(): string | null {
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ];

  for (const name of names) {
    const result = spawnSync("which", [name], {
      encoding: "utf-8",
      timeout: 5_000,
    });

    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  const paths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];

  return paths.find((current_path) => existsSync(current_path)) ?? null;
}

export function getChromeVersion({ chromePath }: { chromePath: string }): string | null {
  const result = spawnSync(chromePath, ["--version"], {
    encoding: "utf-8",
    timeout: 10_000,
  });

  if (result.status !== 0) {
    return null;
  }

  const parts = result.stdout.trim().split(/\s+/);
  return parts.at(-1) ?? null;
}