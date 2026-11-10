import { Badge } from "@camber/components/badge";
import { createRawSnippet, mount, unmount } from "svelte";
import type { DesktopContextMenuTheme } from "./desktopContextMenu";

/**
 * Resolves the webview's menu styling tokens into concrete colors for the
 * native menu, whose rows are custom views styled to match the DOM
 * `menu-surface` exactly. Tokens are read from the live DOM (a hidden probe
 * with the same utility classes the DOM menus use), so whatever theme or host
 * palette is active is what the native menu paints with.
 */

/**
 * Hardcoded values matching the desktop app's dark theme (see the
 * `.vscode-dark` block in app.css), used per token when the live DOM cannot
 * be sampled or a computed color cannot be parsed. The resolver never throws.
 * `hoverBorder` is intentionally absent: it is accent-derived at runtime and
 * an absent value means "no ring", the safe default.
 */
export const FALLBACK_NATIVE_MENU_THEME: DesktopContextMenuTheme = Object.freeze({
  isDark: true,
  // --vscode-foreground: rgb(255 255 255 / 85%)
  textPrimary: "#ffffffd9",
  // --vscode-descriptionForeground
  textSecondary: "#959da5",
  // color-mix of descriptionForeground with the half-alpha unfocused tab color
  textTertiary: "#959da5f9",
  // --psx-highlight-background (--vscode-list-hoverBackground)
  hoverBackground: "#282e34",
  // --psx-menu-separator -> --psx-border (--vscode-editorGroup-border)
  separator: "#1b1f23",
  // The Badge component's default pill: bg-blue-500/10 with text-blue-400
  // (fixed Tailwind palette, not a theme surface token).
  badgeBackground: "#3b82f61a",
  badgeText: "#60a5fa",
  // --psx-error-foreground (--vscode-terminal-ansiBrightRed)
  destructiveText: "#f97583",
  // --psx-icon reads at primary-text contrast
  iconColor: "#ffffffd9",
});

// The utility class (and property) each simple wire theme field samples.
// Sampling happens inside a `menu-surface` probe so surface-scoped remaps
// apply — the surface re-points --psx-menu-hover-background at
// --psx-highlight-background, exactly as the DOM menus render it. The badge
// fields are sampled from the real Badge component instead (see sampleBadge),
// and hoverBorder from the highlight-border custom property (sampleHoverBorder).
const TOKEN_SAMPLES = {
  textPrimary: { className: "text-psx-foreground-primary", property: "color" },
  textSecondary: { className: "text-psx-foreground-secondary", property: "color" },
  textTertiary: { className: "text-psx-foreground-tertiary", property: "color" },
  hoverBackground: { className: "bg-psx-menu-hover-background", property: "background-color" },
  separator: { className: "menu-separator", property: "background-color" },
  destructiveText: { className: "text-psx-error-foreground", property: "color" },
  iconColor: { className: "text-psx-icon", property: "color" },
} as const satisfies Partial<
  Record<
    keyof DesktopContextMenuTheme,
    { className: string; property: "color" | "background-color" }
  >
>;

/**
 * Samples the current menu token colors from the DOM. Cheap (one probe mount
 * and a handful of getComputedStyle reads), so call it fresh at menu-open time
 * rather than caching across theme changes. Never throws: any token that
 * cannot be resolved falls back to its dark-theme value.
 */
export function resolveNativeMenuTheme(): DesktopContextMenuTheme {
  try {
    const probe = document.createElement("div");
    probe.className = "menu-surface";
    probe.style.cssText =
      "position: fixed; left: -9999px; top: 0; visibility: hidden; pointer-events: none;";
    document.body.appendChild(probe);
    try {
      const theme = { ...FALLBACK_NATIVE_MENU_THEME };
      // Mirrors the app styles' own dark detection: Tailwind's `dark` variant
      // matches descendants of `.psx-dark` / `.vscode-dark` (see variants.css;
      // the desktop host toggles `vscode-dark` on the root element).
      theme.isDark = probe.closest(".psx-dark, .vscode-dark") !== null;
      for (const [field, sample] of Object.entries(TOKEN_SAMPLES) as [
        keyof typeof TOKEN_SAMPLES,
        (typeof TOKEN_SAMPLES)[keyof typeof TOKEN_SAMPLES],
      ][]) {
        theme[field] = sampleToken(probe, sample) ?? FALLBACK_NATIVE_MENU_THEME[field];
      }

      const badge = sampleBadge(probe);
      theme.badgeBackground = badge.background ?? FALLBACK_NATIVE_MENU_THEME.badgeBackground;
      theme.badgeText = badge.text ?? FALLBACK_NATIVE_MENU_THEME.badgeText;

      // Optional: transparent (the shared default) means no ring, so the
      // field is omitted entirely rather than shipping an invisible color.
      const hoverBorder = sampleHoverBorder(probe);
      if (hoverBorder !== undefined) theme.hoverBorder = hoverBorder;
      return theme;
    } finally {
      probe.remove();
    }
  } catch {
    return { ...FALLBACK_NATIVE_MENU_THEME };
  }
}

/**
 * Resolves a raw CSS color — possibly a `var()` reference such as
 * `agentBrandTint`'s `var(--psx-vibrant)` — to hex by letting the cascade
 * compute it on a hidden probe. Returns `undefined` when it cannot be
 * resolved (never throws).
 */
export function resolveCssColorToHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const direct = cssColorToHex(value);
  if (direct !== undefined) return visibleHex(direct);
  if (!value.includes("var(")) return undefined;
  try {
    const probe = document.createElement("span");
    probe.style.cssText = "position: fixed; left: -9999px; visibility: hidden;";
    probe.style.color = value;
    document.body.appendChild(probe);
    try {
      return visibleHex(cssColorToHex(getComputedStyle(probe).getPropertyValue("color")));
    } finally {
      probe.remove();
    }
  } catch {
    return undefined;
  }
}

function sampleToken(
  probe: HTMLElement,
  sample: { className: string; property: "color" | "background-color" },
): string | undefined {
  try {
    const element = document.createElement("div");
    element.className = sample.className;
    probe.appendChild(element);
    try {
      return visibleHex(cssColorToHex(getComputedStyle(element).getPropertyValue(sample.property)));
    } finally {
      element.remove();
    }
  } catch {
    return undefined;
  }
}

// Samples what the SELECTED pill really renders by mounting the exact Badge
// the DOM rows use (`<Badge size="xs" class="uppercase">Selected</Badge>` in
// DropdownItem) and reading its computed colors — resilient to the component's
// own defaults changing. The badge draws no border, so none is sampled.
function sampleBadge(probe: HTMLElement): { background?: string; text?: string } {
  try {
    const host = document.createElement("div");
    probe.appendChild(host);
    const component = mount(Badge, {
      target: host,
      props: {
        size: "xs" as const,
        class: "uppercase",
        children: createRawSnippet(() => ({ render: () => "<span>Selected</span>" })),
      },
    });
    try {
      const badgeElement = host.firstElementChild;
      if (!badgeElement) return {};
      const computed = getComputedStyle(badgeElement);
      return {
        background: visibleHex(cssColorToHex(computed.getPropertyValue("background-color"))),
        text: visibleHex(cssColorToHex(computed.getPropertyValue("color"))),
      };
    } finally {
      void unmount(component);
      host.remove();
    }
  } catch {
    return {};
  }
}

// The row highlight's ring (menu.css draws it as an inset 1px shadow of
// --psx-highlight-border). The pseudo-state rule cannot be sampled directly,
// so the token is resolved by using it as a probe's background — which also
// forces full color computation for var()/color-mix() definitions.
function sampleHoverBorder(probe: HTMLElement): string | undefined {
  try {
    const element = document.createElement("div");
    element.style.backgroundColor = "var(--psx-highlight-border)";
    probe.appendChild(element);
    try {
      return visibleHex(
        cssColorToHex(getComputedStyle(element).getPropertyValue("background-color")),
      );
    } finally {
      element.remove();
    }
  } catch {
    return undefined;
  }
}

// A fully transparent result (zero alpha byte) means the color did not
// resolve or the utility class did not apply — no menu token is legitimately
// invisible; treat it as unresolved.
function visibleHex(hex: string | undefined): string | undefined {
  return hex === undefined || (hex.length === 9 && hex.endsWith("00")) ? undefined : hex;
}

/**
 * Converts a computed CSS color into `#rrggbb` (or `#rrggbbaa` when it has
 * alpha). Handles the serializations engines produce for our tokens: hex,
 * `rgb()`/`rgba()` (comma and slash syntax), `color(srgb …)`,
 * `color(display-p3 …)` (WebKit's serialization for P3-defined tokens like
 * `--psx-vibrant` on wide-gamut displays; gamut-clamped to sRGB), and
 * `oklch()`. Returns `undefined` for anything unrecognized.
 */
export function cssColorToHex(value: string): string | undefined {
  const color = value.trim().toLowerCase();
  if (!color) return undefined;
  if (color === "transparent") return "#00000000";
  if (color.startsWith("#")) return normalizeHex(color);

  const functional = /^(rgba?|color|oklch)\(\s*(.*?)\s*\)$/.exec(color);
  if (!functional) return undefined;
  const [, name, body] = functional;
  // Split "r, g, b, a", "r g b / a", and "srgb r g b / a" alike.
  const parts = body.split(/[\s,/]+/).filter(Boolean);

  if (name === "rgb" || name === "rgba") {
    return rgbToHex(parts.map((part, index) => channel(part, index < 3 ? 255 : 1)));
  }
  if (name === "color") {
    // color(<space> r g b / a): channels are 0–1 numbers or percentages.
    const space = parts[0];
    if ((space !== "srgb" && space !== "display-p3") || parts.length < 4) return undefined;
    const channels = parts
      .slice(1, 4)
      .map((part) => (part.endsWith("%") ? channel(part, 1) : Number.parseFloat(part)));
    const alpha = parts.length > 4 ? channel(parts[4], 1) : 1;
    if ([...channels, alpha].some(Number.isNaN)) return undefined;
    const [r, g, b] = space === "display-p3" ? p3ToSrgb(channels) : channels;
    return formatHex(r, g, b, alpha);
  }
  return oklchToHex(parts);
}

/** Parses one channel: `%` values scale to `max`, numbers pass through. */
function channel(part: string, max: number): number {
  const numeric = Number.parseFloat(part);
  if (Number.isNaN(numeric)) return NaN;
  return part.endsWith("%") ? (numeric / 100) * max : numeric;
}

function rgbToHex(parts: number[]): string | undefined {
  if (parts.length < 3 || parts.some(Number.isNaN)) return undefined;
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (Number.isNaN(alpha)) return undefined;
  return formatHex(r / 255, g / 255, b / 255, alpha);
}

// oklch -> oklab -> LMS -> linear sRGB (Björn Ottosson's OKLab matrices).
function oklchToHex(parts: string[]): string | undefined {
  if (parts.length < 3) return undefined;
  const lightness = channel(parts[0], 1);
  const chroma = Number.parseFloat(parts[1]);
  const hue = Number.parseFloat(parts[2]);
  const alpha = parts.length > 3 ? channel(parts[3], 1) : 1;
  if ([lightness, chroma, hue, alpha].some(Number.isNaN)) return undefined;

  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return formatHex(
    srgbGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    srgbGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    srgbGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha,
  );
}

// Display-P3 (gamma-encoded, 0–1) -> linear -> linear sRGB -> gamma, with
// out-of-sRGB-gamut components clamped.
function p3ToSrgb([r, g, b]: number[]): [number, number, number] {
  const toLinear = (component: number) =>
    Math.abs(component) <= 0.04045
      ? component / 12.92
      : Math.sign(component) * ((Math.abs(component) + 0.055) / 1.055) ** 2.4;
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  return [
    srgbGamma(1.2249401762805587 * lr - 0.2249401762805597 * lg),
    srgbGamma(-0.04205695470968816 * lr + 1.0420569547096881 * lg),
    srgbGamma(-0.019637554590334432 * lr - 0.07863604555063188 * lg + 1.0982735995860243 * lb),
  ];
}

/** Linear sRGB (clamped into gamut) to the gamma-encoded 0–1 channel. */
function srgbGamma(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** Channels in 0–1; alpha omitted from the hex when fully opaque. */
function formatHex(r: number, g: number, b: number, alpha: number): string {
  const byte = (component: number) =>
    Math.min(255, Math.max(0, Math.round(component * 255)))
      .toString(16)
      .padStart(2, "0");
  const rgb = `#${byte(r)}${byte(g)}${byte(b)}`;
  return alpha >= 1 ? rgb : `${rgb}${byte(alpha)}`;
}

function normalizeHex(hex: string): string | undefined {
  const digits = hex.slice(1);
  if (!/^[0-9a-f]+$/.test(digits)) return undefined;
  if (digits.length === 3 || digits.length === 4) {
    const expanded = [...digits].map((digit) => digit + digit).join("");
    return normalizeHex(`#${expanded}`);
  }
  if (digits.length === 6) return `#${digits}`;
  if (digits.length === 8) return digits.endsWith("ff") ? `#${digits.slice(0, 6)}` : `#${digits}`;
  return undefined;
}
