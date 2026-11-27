import { writable } from "svelte/store";

// The desktop pane's default corner radius and its inset from the window edge.
const PANEL_RADIUS = 10;
const PANEL_INSET = 8;

export interface DesktopWindowCorners {
  bottomLeft: number | null;
  bottomRight: number | null;
}

export const desktopPanelCorners = writable<{ bottomLeft?: number; bottomRight?: number }>({});

export function applyDesktopWindowCorners(corners: DesktopWindowCorners): void {
  desktopPanelCorners.set({
    bottomLeft: panelRadius(corners.bottomLeft),
    bottomRight: panelRadius(corners.bottomRight),
  });
}

function panelRadius(radius: number | null): number | undefined {
  const insetRadius = (radius ?? 0) - PANEL_INSET;
  return insetRadius > PANEL_RADIUS ? insetRadius : undefined;
}
