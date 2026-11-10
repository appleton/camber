import Icon, { type IconName } from "@camber/components/icon";
import { mount, unmount } from "svelte";
import type { DesktopContextMenuIcon, DesktopContextMenuStarIcons } from "./desktopContextMenu";
import { FALLBACK_NATIVE_MENU_THEME } from "./nativeMenuTheme";

/**
 * UI-level icon reference for native menu items:
 *
 * - a product icon name (rasterized in the menu theme's default glyph color),
 * - `{ name, color }` to override that color (e.g. destructive rows),
 * - `{ url, color }` for mask-style image icons (agent icons): the image's
 *   alpha is filled with `color` — or the default glyph color — matching the
 *   DOM's `bg-current` CSS mask (brand-tinted rows pass the tint as `color`);
 *   `overlayUrl` stacks a second mask over the first (the local agent's badge
 *   sits in the notch of its roundel), both silhouettes filled flat with the
 *   same color like the DOM's stacked `bg-current` spans,
 * - `{ image }` for full-color artwork (app icons passed as data URIs): drawn
 *   contain-fit and centered with its own colors, never masked or recolored;
 *   `scale` grows the artwork about the center, mirroring the DOM's slight
 *   upscale for icons with wide transparent padding,
 * - `{ svg, color }` for raw SVG markup (components like EffortBarsIcon that
 *   are not in the icon set), honoring `currentColor`,
 * - `{ file }` for the OS's own icon for the file at this absolute path (e.g.
 *   the real macOS folder icon for a project directory): a pure passthrough
 *   for the native host to resolve via NSWorkspace — nothing rasterizes in
 *   the webview, and the icon always renders full color.
 *
 * The native menu renders our webview look 1:1, so glyphs always rasterize in
 * color — product icon names are never substituted with SF Symbols.
 */
export type NativeMenuIcon =
  | IconName
  | { name: IconName; color?: string }
  | { url: string; color?: string; overlayUrl?: string }
  | { image: string; scale?: number }
  | { svg: string; color?: string }
  | { file: string };

/** Logical icon edge in CSS px; the canvas renders at devicePixelRatio scale. */
const ICON_SIZE = 16;

/** Logical star edge in CSS px — `DefaultStarButton` renders the 13px glyph. */
const STAR_ICON_SIZE = 13;

/**
 * How long one menu open waits for an icon build before presenting without
 * it. `presentNativeMenu` awaits every icon before showing the menu, so a
 * hung build (e.g. a remote agent-icon fetch that never settles) must not
 * wedge menu opens — after the deadline the caller gets `undefined` and the
 * row simply shows no icon. The deadline also declares the build hung: it is
 * evicted from the cache (and its remote fetch aborted), so only the first
 * open pays the deadline — later opens start a fresh build instead of
 * awaiting the same forever-pending one (see `raceBuildDeadline`).
 */
const ICON_BUILD_DEADLINE_MS = 1500;

interface IconBuild {
  promise: Promise<DesktopContextMenuIcon>;
  /** Aborts the build's remote fetch, if any, rejecting `promise`. */
  abort(): void;
}

const wireIconCache = new Map<string, IconBuild>();

/**
 * Converts a UI-level icon reference into the wire icon for a native menu.
 *
 * Glyphs, SVG markup, and URL icons rasterize to a color PNG: the default
 * color is `options.iconColor` (the resolved theme's glyph color),
 * overridable per icon. Never rejects: any failure resolves
 * `undefined` and the menu item simply shows no icon. Results are memoized
 * per icon + color; each caller waits at most `ICON_BUILD_DEADLINE_MS`.
 */
export function wireIconFor(
  icon: NativeMenuIcon,
  options?: { iconColor?: string },
): Promise<DesktopContextMenuIcon | undefined> {
  const iconColor = options?.iconColor ?? FALLBACK_NATIVE_MENU_THEME.iconColor;
  const key = cacheKey(icon, iconColor);
  let build = wireIconCache.get(key);
  if (!build) {
    const controller = new AbortController();
    const created: IconBuild = {
      promise: buildWireIcon(icon, iconColor, controller.signal),
      abort: () => controller.abort(),
    };
    // A failed build must not poison the cache: evict it so the next menu
    // open retries. A success stays cached; a still-pending build stays
    // cached (deduping concurrent opens) only until a caller's deadline
    // declares it hung — see raceBuildDeadline.
    created.promise.catch(() => {
      if (wireIconCache.get(key) === created) wireIconCache.delete(key);
    });
    wireIconCache.set(key, created);
    build = created;
  }
  return raceBuildDeadline(build, key);
}

/**
 * Rasterizes the product `star` glyph — the exact 13px glyph
 * `DefaultStarButton` renders — in the three colors a native star row paints
 * it with (pinned / normal / hover), at devicePixelRatio scale. Purely local
 * (no fetch), so no deadline or cache applies; never rejects — any failure
 * resolves `undefined` and the menu presents without star icons.
 */
export async function starIconsFor(colors: {
  pinned: string;
  normal: string;
  hover: string;
}): Promise<DesktopContextMenuStarIcons | undefined> {
  try {
    const [pinned, normal, hover] = await Promise.all([
      rasterizeGlyph("star", colors.pinned, STAR_ICON_SIZE),
      rasterizeGlyph("star", colors.normal, STAR_ICON_SIZE),
      rasterizeGlyph("star", colors.hover, STAR_ICON_SIZE),
    ]);
    return { pinned, normal, hover };
  } catch {
    return undefined;
  }
}

// Resolve with the built icon, or `undefined` when the build fails or the
// deadline passes first. The timer is cleared as soon as the build settles so
// a fast build leaves no stray timer behind.
//
// A deadline firing also declares the build hung, so it must only ever tax
// the open that discovered it: the cache entry is evicted (the guard keeps a
// newer rebuild at the same key intact, and a late settle of the orphaned
// build is harmless) so the next open starts fresh instead of awaiting the
// corpse, and the build's remote fetch, if any, is aborted — rejecting the
// shared promise. Builds without a fetch (glyph/SVG/image rasterization) have
// nothing to abort, but the eviction still keeps them from pending in the
// cache forever. Concurrent opens share one build under independent deadlines
// of the same length, so the first deadline to fire is the earliest caller's:
// the build has already had a full deadline to settle, and the abort hands
// later joiners `undefined` at most their join stagger early — an acceptable
// trade for keeping every subsequent open fast.
function raceBuildDeadline(
  build: IconBuild,
  key: string,
): Promise<DesktopContextMenuIcon | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
      if (wireIconCache.get(key) === build) wireIconCache.delete(key);
      build.abort();
    }, ICON_BUILD_DEADLINE_MS);
    build.promise.then(
      (icon) => {
        clearTimeout(timer);
        resolve(icon);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function cacheKey(icon: NativeMenuIcon, iconColor: string): string {
  // The raster surface sizes by the live devicePixelRatio, so the same icon
  // produces different bitmaps on 1x and 2x displays; keying on it keeps a
  // window that moved between displays from serving stale-resolution icons.
  const dpr = window.devicePixelRatio || 1;
  if (typeof icon === "string") return `dpr:${dpr}:name:${icon}:${iconColor}`;
  if ("url" in icon)
    return `dpr:${dpr}:url:${icon.url}:overlay:${icon.overlayUrl ?? ""}:${icon.color ?? iconColor}`;
  if ("image" in icon) return `dpr:${dpr}:image:${icon.scale ?? 1}:${icon.image}`;
  if ("svg" in icon) return `dpr:${dpr}:svg:${icon.color ?? iconColor}:${icon.svg}`;
  // The OS resolves file icons at native resolution, so DPR never applies.
  if ("file" in icon) return `file:${icon.file}`;
  return `dpr:${dpr}:name:${icon.name}:${icon.color ?? iconColor}`;
}

async function buildWireIcon(
  icon: NativeMenuIcon,
  iconColor: string,
  signal: AbortSignal,
): Promise<DesktopContextMenuIcon> {
  if (typeof icon === "string") {
    return { pngBase64: await rasterizeGlyph(icon, iconColor) };
  }
  if ("url" in icon) {
    return {
      pngBase64: await rasterizeUrlMask(icon.url, icon.color ?? iconColor, icon.overlayUrl, signal),
    };
  }
  if ("image" in icon) {
    return { pngBase64: await rasterizeImage(icon.image, icon.scale) };
  }
  if ("svg" in icon) {
    return {
      pngBase64: await rasterizeSvgMarkup(icon.svg, icon.color ?? iconColor),
    };
  }
  if ("file" in icon) {
    return { filePath: icon.file };
  }
  return { pngBase64: await rasterizeGlyph(icon.name, icon.color ?? iconColor) };
}

/**
 * Renders a product icon's SVG glyph off-screen and encodes it as PNG bytes
 * in the requested color (glyphs stroke with `currentColor`). `size` is the
 * logical edge in CSS px (menu item icons default to 16; stars raster at 13).
 */
async function rasterizeGlyph(name: IconName, color: string, size = ICON_SIZE): Promise<string> {
  // Created first: fails fast where 2D canvas is unavailable, before any
  // image load is awaited.
  const surface = createRasterSurface(size);
  const container = document.createElement("div");
  container.style.color = color;
  const component = mount(Icon, { target: container, props: { name, size } });
  try {
    const svg = container.querySelector("svg");
    if (!svg) throw new Error(`No SVG rendered for icon "${name}"`);
    svg.setAttribute("color", color);
    const markup = new XMLSerializer().serializeToString(svg);
    surface.drawContained(await loadImage(svgDataUrl(markup)));
    return surface.toBase64();
  } finally {
    void unmount(component);
    container.remove();
  }
}

/**
 * Rasterizes raw SVG markup (e.g. a serialized EffortBarsIcon) in the
 * requested color: `currentColor` in the markup resolves to it.
 */
async function rasterizeSvgMarkup(markup: string, color: string): Promise<string> {
  const surface = createRasterSurface();
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  if (parsed.nodeName !== "svg") throw new Error("Menu icon markup is not an <svg>");
  parsed.setAttribute("color", color);
  const serialized = new XMLSerializer().serializeToString(parsed);
  surface.drawContained(await loadImage(svgDataUrl(serialized)));
  return surface.toBase64();
}

/**
 * Rasterizes a mask-style image icon the way the DOM renders it: the image's
 * alpha silhouette filled with a flat color (`RegistryAgentIcon` masks its
 * URLs to `bg-current`, `center / contain`). An overlay mask (the local
 * agent's badge) draws over the base before the single fill — `fillMask`
 * recolors everything drawn so far, so filling once after both draws leaves
 * both silhouettes flat in the same color, like the DOM's stacked spans.
 */
async function rasterizeUrlMask(
  url: string,
  color: string,
  overlayUrl: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const surface = createRasterSurface();
  surface.drawContained(await loadMaskImage(url, signal));
  if (overlayUrl) surface.drawContained(await loadMaskImage(overlayUrl, signal));
  surface.fillMask(color);
  return surface.toBase64();
}

/**
 * Rasterizes full-color artwork (app icons passed as data URIs) the way the
 * DOM's `<img>` renders it: contain-fit, centered, keeping the image's own
 * colors — no mask or recolor. Loaded via `<img src>` (governed by img-src)
 * rather than `fetch` (connect-src), so data URIs pass the webview CSP.
 * `scale` mirrors the DOM's slight upscale for padded artwork.
 */
async function rasterizeImage(src: string, scale?: number): Promise<string> {
  const surface = createRasterSurface();
  surface.drawContained(await loadImage(src), scale);
  return surface.toBase64();
}

/**
 * Loads a mask image for canvas use. Data URIs load through `<img src>`
 * directly — no fetch, so the webview CSP's connect-src never applies and the
 * canvas stays untainted. Remote URLs keep the fetch → blob → object-URL path
 * so CORS-approved bytes draw without tainting the canvas; `signal` lets a
 * menu-open deadline abort a hung fetch so the build rejects instead of
 * pending forever (see `raceBuildDeadline`).
 */
async function loadMaskImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  if (url.startsWith("data:")) return loadImage(url);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to load menu icon (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await loadImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

interface RasterSurface {
  /**
   * Draws the image contain-fit, centered (as the DOM's CSS mask does).
   * `scale` grows the fitted artwork about the center, matching the DOM's
   * upscale for icons with wide transparent padding.
   */
  drawContained(image: HTMLImageElement, scale?: number): void;
  /** Recolors everything drawn so far to `color`, keeping only its alpha. */
  fillMask(color: string): void;
  toBase64(): string;
}

function createRasterSurface(size = ICON_SIZE): RasterSurface {
  const side = Math.round(size * (window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");

  return {
    drawContained(image, scale = 1) {
      const width = image.naturalWidth || side;
      const height = image.naturalHeight || side;
      const fit = Math.min(side / width, side / height) * scale;
      const drawWidth = width * fit;
      const drawHeight = height * fit;
      context.drawImage(
        image,
        (side - drawWidth) / 2,
        (side - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
    },
    fillMask(color) {
      context.globalCompositeOperation = "source-in";
      context.fillStyle = color;
      context.fillRect(0, 0, side, side);
      context.globalCompositeOperation = "source-over";
    },
    toBase64() {
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",", 2)[1];
      if (!base64) throw new Error("Unable to encode menu icon PNG");
      return base64;
    },
  };
}

function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load menu icon image"));
    image.src = src;
  });
}
