// Font-size-based zoom for the desktop window.
//
// The webview's native zoom hotkeys scale the whole page with a CSS-zoom
// factor, which breaks every `position: fixed` popup: coordinates are
// computed in layout pixels but rendered multiplied by the zoom factor, so
// menus drift off their anchors or land entirely outside the window
// (PE-2384, PE-2386) and phantom scrollbars appear (PE-2378). Instead,
// Cmd +/−/0 scales type only: the root font size (which rem-based type and
// spacing follow) plus the chat font variables via the onChange callback.
// Layout coordinates stay 1:1 with the viewport, so popups stay anchored.

const ZOOM_STORAGE_KEY = "camber-desktop-zoom-level";
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

let zoomLevel = 1;
let onChange: (() => void) | undefined;

export function currentZoomLevel(): number {
  return zoomLevel;
}

function clampZoom(level: number): number {
  const rounded = Math.round(level * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded));
}

function readStoredZoom(): number {
  const raw = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : 1;
}

function setZoomLevel(level: number): void {
  const next = clampZoom(level);
  if (next === zoomLevel) return;
  zoomLevel = next;
  localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
  applyRootZoom();
  onChange?.();
}

function applyRootZoom(): void {
  document.documentElement.style.fontSize = zoomLevel === 1 ? "" : `${zoomLevel * 100}%`;
}

function handleZoomKeydown(event: KeyboardEvent): void {
  const isMac = navigator.userAgent.includes("Macintosh");
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (!modifier || event.altKey) return;
  if (event.key === "=" || event.key === "+") {
    setZoomLevel(zoomLevel + ZOOM_STEP);
  } else if (event.key === "-") {
    setZoomLevel(zoomLevel - ZOOM_STEP);
  } else if (event.key === "0") {
    setZoomLevel(1);
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Restores the persisted zoom level and binds Cmd/Ctrl +/−/0. `handleChange`
 * fires after the root font size updates so px-based font variables (chat
 * font size and leading) can be rescaled too.
 */
export function installDesktopZoom(handleChange: () => void): void {
  onChange = handleChange;
  zoomLevel = readStoredZoom();
  applyRootZoom();
  window.addEventListener("keydown", handleZoomKeydown, { capture: true });
}
