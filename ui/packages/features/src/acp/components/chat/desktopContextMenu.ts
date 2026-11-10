import { get } from "svelte/store";
import { appState } from "../../hostAdapter";
import { rpc, type RPCClient } from "../../hostRpc";
import { resolveNativeMenuTheme } from "./nativeMenuTheme";

/**
 * Generic native context-menu spec types.
 *
 * These mirror the wire shape consumed by the desktop host's
 * `showDesktopContextMenu` RPC and the native `show_native_menu` Tauri
 * command. Construct the spec array (icons must already be wire icons — see
 * `nativeMenuIcons.ts` / `menuSpec.ts` for the UI-level conversion), then
 * call `showDesktopContextMenu` to pop it up.
 */

/** Native menu item icon. Provide a file path or PNG bytes. */
export interface DesktopContextMenuIcon {
  /**
   * Absolute filesystem path whose OS icon to show (the system's own icon
   * for the file at this path, e.g. the real macOS folder icon). Resolved
   * host-side via NSWorkspace; always renders full color and takes
   * precedence over the other fields.
   */
  filePath?: string;
  /** Base64-encoded PNG, pre-rasterized in color by the webview. */
  pngBase64?: string;
}

export type DesktopContextMenuSpecItem =
  | {
      kind: "action";
      /** Unique identifier returned when the user selects this item. */
      id: string;
      label: string;
      /** Secondary line rendered under the label. */
      sublabel?: string;
      icon?: DesktopContextMenuIcon;
      /** Renders a checkmark next to the item. */
      checked?: boolean;
      enabled?: boolean;
      accelerator?: string;
      toolTip?: string;
      /** Renders with destructive (red) styling. */
      destructive?: boolean;
      /**
       * Nesting depth in levels; each level shifts the icon and label right
       * by 16pt natively (e.g. worktree rows under their parent project).
       */
      indent?: number;
      /**
       * Reserve the icon slot even though this row carries no icon, so its
       * label aligns with icon-bearing siblings at the same menu level.
       */
      reserveIconSlot?: boolean;
      /**
       * Presence makes the row a native star row: a trailing, hover-revealed
       * star button (filled when `starred`) that toggles the row's pinned
       * default state without closing the menu. Clicks report through the
       * `native-menu:set-default` Tauri event, matched to the request by its
       * `token`, carrying the star's NEW state.
       */
      star?: { starred: boolean };
      /**
       * Star radio group for the native radio-with-toggle: a star click
       * clears the stars of the other rows in the SAME group only. Rows
       * without a group each form their own singleton group, so starring
       * them clears no other row.
       */
      starGroup?: string;
    }
  | {
      kind: "separator";
      /** When present the separator renders as a section header. */
      label?: string;
    }
  | {
      kind: "submenu";
      label: string;
      /**
       * Current selection summary, drawn as right-aligned secondary text
       * before the chevron (like the DOM panel's dimmed value column).
       */
      detail?: string;
      icon?: DesktopContextMenuIcon;
      enabled?: boolean;
      /**
       * Reserve the icon slot even though this row carries no icon, so its
       * label aligns with icon-bearing siblings at the same menu level.
       */
      reserveIconSlot?: boolean;
      /**
       * Minimum content width in pt for this submenu's own level, with the
       * same semantics as the request-level `minWidth`: the level lays out
       * at least this wide and its sublabels wrap to at most two lines
       * instead of widening the menu. Omit to fit content.
       */
      minWidth?: number;
      items: DesktopContextMenuSpecItem[];
    };

/**
 * Colors the native menu paints its custom rows with, so it renders exactly
 * like the DOM `menu-surface` dropdowns. All colors are CSS `#rrggbb` or
 * `#rrggbbaa` hex, resolved from the live webview theme at menu-open time
 * (see `nativeMenuTheme.ts`).
 */
export interface DesktopContextMenuTheme {
  isDark: boolean;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  /** Row highlight fill (`--psx-menu-hover-background` inside a menu surface). */
  hoverBackground: string;
  /**
   * Ring around the row highlight (`--psx-highlight-border`, drawn by the DOM
   * as a 1px inset shadow). Omitted when the theme resolves it transparent —
   * absent means skip the ring, like the DOM.
   */
  hoverBorder?: string;
  /** Group divider hairline (`--psx-menu-separator`, i.e. `--psx-border`). */
  separator: string;
  /**
   * SELECTED pill fill and text, sampled from the real `Badge` component the
   * DOM rows render (a fixed blue-tinted pill, not a theme surface token).
   */
  badgeBackground: string;
  badgeText: string;
  /** Danger row label color (`--psx-error-foreground`). */
  destructiveText: string;
  /** Default glyph color (the `text-psx-icon` token). */
  iconColor: string;
}

/**
 * The star button states a native star row paints, rasterized by the webview
 * from the product `star` glyph (base64 PNGs at 13px × devicePixelRatio) so
 * the native rows render `DefaultStarButton`'s exact visuals: `pinned` is the
 * always-visible vibrant star, `normal` the hover-revealed tertiary star on
 * unpinned rows, and `hover` the primary-text lift under the pointer.
 */
export interface DesktopContextMenuStarIcons {
  pinned: string;
  normal: string;
  hover: string;
}

export interface DesktopContextMenuRequest {
  /** Logical CSS px in webview coordinates. */
  position: { x: number; y: number };
  /** "end" puts the menu's right edge at `position.x`. Defaults to "start". */
  align?: "start" | "end";
  /** Row highlight appearance; defaults to the standard macOS selection. */
  highlightStyle?: "system" | "themed";
  /**
   * Correlates star-row clicks with this menu: while it is open, each click
   * emits a set-default event carrying the token back, so a listener can
   * ignore events from other menus. Sent only when the spec has star rows.
   */
  token?: string;
  /** Webview menu styling for the native rows. */
  theme: DesktopContextMenuTheme;
  /** Star raster states for star rows; sent only when the spec has them. */
  starIcons?: DesktopContextMenuStarIcons;
  /** Minimum menu width in pt (e.g. the config pickers); omit for fit. */
  minWidth?: number;
  items: DesktopContextMenuSpecItem[];
}

/**
 * Window CustomEvent the desktop host re-dispatches when a native star row is
 * clicked while a menu is open (from the `native-menu:set-default` Tauri
 * event). The menu stays open; selection still resolves the menu promise.
 */
export const NATIVE_MENU_SET_DEFAULT_EVENT = "camber:native-menu-set-default";

export interface NativeMenuSetDefaultPayload {
  /** The `token` of the menu request the click belongs to. */
  token: string | null;
  /** The clicked action item's id. */
  id: string;
  /** The row's NEW starred (pinned) state after the click. */
  starred: boolean;
}

interface NativeMenuEnvironment {
  assistantHost: string;
  operatingSystem?: string;
}

/** True when the host presents OS-native menus (the desktop app on macOS). */
export function supportsNativeMenus(environment: NativeMenuEnvironment): boolean {
  return environment.assistantHost === "desktop" && environment.operatingSystem === "darwin";
}

type DesktopContextMenuRPC = RPCClient & {
  showDesktopContextMenu(request: DesktopContextMenuRequest): Promise<string | null>;
};

/**
 * Show a native context menu on the desktop host.
 *
 * Resolves with the `id` of the action the user selected, or `undefined`
 * when the menu closed without a selection. The host's RPC resolves when the
 * menu actually closes, so dismissal reports immediately.
 *
 * No-op (returns `undefined`) when not on the desktop host.
 */
export async function showDesktopContextMenu(
  items: DesktopContextMenuSpecItem[],
  position: { x: number; y: number },
  options?: {
    align?: "start" | "end";
    highlightStyle?: DesktopContextMenuRequest["highlightStyle"];
    token?: string;
    theme?: DesktopContextMenuTheme;
    starIcons?: DesktopContextMenuStarIcons;
    minWidth?: number;
  },
): Promise<string | undefined> {
  if (!isDesktopHost()) return undefined;

  const desktopRpc = rpc as DesktopContextMenuRPC;
  try {
    const selected = await desktopRpc.showDesktopContextMenu({
      position,
      align: options?.align,
      highlightStyle: options?.highlightStyle,
      token: options?.token,
      // Every request carries the webview menu styling; callers that already
      // resolved a theme (presentNativeMenu) pass it through.
      theme: options?.theme ?? resolveNativeMenuTheme(),
      starIcons: options?.starIcons,
      minWidth: options?.minWidth,
      items,
    });
    return selected ?? undefined;
  } catch (error) {
    console.debug("Unable to show context menu", error);
    return undefined;
  }
}

function isDesktopHost(): boolean {
  return get(appState).environment.assistantHost === "desktop";
}
