// Theme for the mobile surface, mirroring the desktop app's GitHub light/dark
// token themes without the Tauri native calls. The preference (system, light,
// dark) comes from the mobile app's own settings — see settings.ts.

import type { MobileThemePreference } from "@camber/assistant";

export type ResolvedTheme = "light" | "dark";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const GITHUB_DARK_COLOR_THEME = {
  name: "GitHub Dark",
  tokenColors: [
    { scope: "comment", settings: { foreground: "#8b949e" } },
    { scope: "constant", settings: { foreground: "#79c0ff" } },
    { scope: "entity.name.function", settings: { foreground: "#d2a8ff" } },
    { scope: "entity.name.tag", settings: { foreground: "#7ee787" } },
    { scope: "keyword", settings: { foreground: "#ff7b72" } },
    { scope: "string", settings: { foreground: "#a5d6ff" } },
    { scope: "variable", settings: { foreground: "#ffa657" } },
    { scope: "invalid", settings: { foreground: "#f0f6fc", background: "#8e1519" } },
    { scope: "markup.heading", settings: { foreground: "#1f6feb", fontStyle: "bold" } },
    { scope: "markup.bold", settings: { foreground: "#c9d1d9", fontStyle: "bold" } },
    { scope: "markup.italic", settings: { foreground: "#c9d1d9", fontStyle: "italic" } },
    { scope: "markup.link", settings: { foreground: "#a5d6ff" } },
  ],
};

const GITHUB_LIGHT_COLOR_THEME = {
  name: "GitHub Light",
  tokenColors: [
    { scope: "comment", settings: { foreground: "#57606a" } },
    { scope: "constant", settings: { foreground: "#0550ae" } },
    { scope: "entity.name.function", settings: { foreground: "#6639ba" } },
    { scope: "entity.name.tag", settings: { foreground: "#0550ae" } },
    { scope: "keyword", settings: { foreground: "#cf222e" } },
    { scope: "string", settings: { foreground: "#0a3069" } },
    { scope: "variable", settings: { foreground: "#953800" } },
    { scope: "invalid", settings: { foreground: "#f6f8fa", background: "#82071e" } },
    { scope: "markup.heading", settings: { foreground: "#0550ae", fontStyle: "bold" } },
    { scope: "markup.bold", settings: { foreground: "#24292f", fontStyle: "bold" } },
    { scope: "markup.italic", settings: { foreground: "#24292f", fontStyle: "italic" } },
    { scope: "markup.link", settings: { foreground: "#0a3069" } },
  ],
};

export function mobileColorTheme(theme: ResolvedTheme) {
  return theme === "dark" ? GITHUB_DARK_COLOR_THEME : GITHUB_LIGHT_COLOR_THEME;
}

export function resolveMobileTheme(preference: MobileThemePreference): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

// Notifies when the OS light/dark preference flips; the caller decides whether
// it matters (only when the stored preference is "system").
export function onSystemThemeChange(listener: () => void): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  const handler = () => listener();
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

export function applyMobileTheme(preference: MobileThemePreference = "system"): ResolvedTheme {
  const resolved = resolveMobileTheme(preference);
  document.documentElement.classList.toggle("vscode-light", resolved === "light");
  document.documentElement.classList.toggle("vscode-dark", resolved === "dark");
  document.body.classList.toggle("vscode-light", resolved === "light");
  document.body.classList.toggle("vscode-dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
  document.body.style.colorScheme = resolved;
  return resolved;
}
