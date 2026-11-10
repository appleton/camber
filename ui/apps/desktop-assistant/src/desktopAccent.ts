import { listen } from "@tauri-apps/api/event";
import { getSystemAccentColors, type SystemAccentColors } from "./rpc/host";

/**
 * The user's macOS accent colour, applied to the webview as CSS custom
 * properties. WKWebView hardcodes the CSS `AccentColor` / `Highlight` system
 * colours to blue and never follows System Settings, so the real colours come
 * from AppKit over the bridge in src-tauri/src/system_accent.rs.
 *
 * Both appearances are published at once (`--desktop-system-accent-light` and
 * `-dark`) and app.css picks the pair matching the active theme class. That
 * keeps the accent in step with light/dark without re-reading anything when the
 * appearance changes.
 */

export const SYSTEM_ACCENT_CHANGED_EVENT = "camber:desktop-system-accent-changed";
const SYSTEM_ACCENT_CLASS = "desktop-system-accent";
const SYSTEM_ACCENT_STORAGE_KEY = "camber-desktop-system-accent";

/**
 * The colour forms system_accent.rs emits: `#rrggbb`, or `rgb(r g b / p%)` if a
 * bridged colour ever turns out not to be opaque. Values round-trip through
 * localStorage, which the webview can write, so they are re-validated rather
 * than trusted straight into the cascade.
 */
const CSS_COLOR_PATTERN = /^(#[0-9a-f]{6}|rgb\(\d{1,3} \d{1,3} \d{1,3} \/ \d{1,3}(\.\d+)?%\))$/;

interface AccentVariables {
  "--desktop-system-accent-light": string;
  "--desktop-system-accent-dark": string;
  "--desktop-system-accent-foreground-light": string;
  "--desktop-system-accent-foreground-dark": string;
  "--desktop-system-accent-selection-light": string;
  "--desktop-system-accent-selection-dark": string;
}

/**
 * Applies the cached accent before the first paint. The bridge read below can
 * wait on app startup, and without a seed every launch would flash the built-in
 * blue before settling on the user's accent.
 */
export function seedDesktopAccentFromCache(): void {
  const cached = readCachedAccentColors();
  if (!cached) return;
  writeAccentVariables(cached);
  document.documentElement.classList.add(SYSTEM_ACCENT_CLASS);
}

/**
 * Reads the current accent over the bridge and applies it. Returns the colours
 * so callers can keep them for a later settings change without a second read.
 */
export async function applyDesktopAccent(): Promise<SystemAccentColors | null> {
  let colors: SystemAccentColors | null = null;
  try {
    colors = await getSystemAccentColors();
  } catch (error) {
    console.debug("Unable to read the macOS accent colour", error);
  }
  setDesktopAccent(colors);
  return colors;
}

/**
 * Applies the accent variables. With no colours — off macOS, or if the read
 * failed — the class stays off and the stylesheet keeps its own blue.
 */
export function setDesktopAccent(colors: SystemAccentColors | null): void {
  const variables = colors && accentVariables(colors);
  if (!variables) {
    document.documentElement.classList.remove(SYSTEM_ACCENT_CLASS);
    return;
  }

  writeAccentVariables(variables);
  cacheAccentColors(variables);
  document.documentElement.classList.add(SYSTEM_ACCENT_CLASS);
}

/**
 * Follows System Settings while the app is running. AppKit posts the change
 * in-process and system_accent.rs forwards it, so picking a new accent recolours
 * the window without a relaunch.
 */
export function watchDesktopAccent(onChange?: (colors: SystemAccentColors) => void): void {
  void listen<SystemAccentColors>(SYSTEM_ACCENT_CHANGED_EVENT, (event) => {
    setDesktopAccent(event.payload);
    onChange?.(event.payload);
  });
}

const ACCENT_VARIABLE_NAMES = [
  "--desktop-system-accent-light",
  "--desktop-system-accent-dark",
  "--desktop-system-accent-foreground-light",
  "--desktop-system-accent-foreground-dark",
  "--desktop-system-accent-selection-light",
  "--desktop-system-accent-selection-dark",
] as const satisfies readonly (keyof AccentVariables)[];

function accentVariables(colors: SystemAccentColors): AccentVariables | null {
  return validAccentVariables({
    "--desktop-system-accent-light": colors.light?.accent,
    "--desktop-system-accent-dark": colors.dark?.accent,
    "--desktop-system-accent-foreground-light": colors.light?.foreground,
    "--desktop-system-accent-foreground-dark": colors.dark?.foreground,
    "--desktop-system-accent-selection-light": colors.light?.selection,
    "--desktop-system-accent-selection-dark": colors.dark?.selection,
  });
}

function validAccentVariables(values: Record<string, unknown>): AccentVariables | null {
  const variables = {} as AccentVariables;

  for (const name of ACCENT_VARIABLE_NAMES) {
    const value = values[name];
    if (typeof value !== "string" || !CSS_COLOR_PATTERN.test(value)) return null;
    variables[name] = value;
  }

  return variables;
}

function writeAccentVariables(variables: AccentVariables): void {
  for (const [name, value] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, value);
  }
}

function cacheAccentColors(variables: AccentVariables): void {
  localStorage.setItem(SYSTEM_ACCENT_STORAGE_KEY, JSON.stringify(variables));
}

function readCachedAccentColors(): AccentVariables | null {
  const cached = localStorage.getItem(SYSTEM_ACCENT_STORAGE_KEY);
  if (!cached) return null;

  try {
    const parsed: unknown = JSON.parse(cached);
    if (!parsed || typeof parsed !== "object") return null;
    return validAccentVariables(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}
