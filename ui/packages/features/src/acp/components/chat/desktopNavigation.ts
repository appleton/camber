import type { PaneID, TabID } from "@camber/splits";
import type { DesktopSplitSurface } from "./desktopSplitsCache";

export interface DesktopSplitNavigationLocation {
  layoutKey: string;
  surface: DesktopSplitSurface;
  paneId: PaneID;
  tabId?: TabID;
}

export interface DesktopSplitNavigationRequest {
  location: DesktopSplitNavigationLocation;
  token: number;
}
