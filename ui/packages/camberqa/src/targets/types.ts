import type { Frame, FrameLocator, Locator, Page } from "playwright";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDisplayInfo {
  id: number;
  label: string;
  isPrimary: boolean;
  bounds: WindowBounds;
  workArea: WindowBounds;
}

export interface WindowInfo {
  displays: WindowDisplayInfo[];
  window: {
    title: string;
    bounds: WindowBounds;
    displayId: number | null;
  };
}

export interface PanelInfo {
  name: string;
  rawFrame: Frame;
}

export type WebIssueKind = "console" | "pageerror";

export interface WebIssue {
  kind: WebIssueKind;
  level: string;
  text: string;
  timestamp: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

export interface CamberQATarget {
  readonly kind: "vscode" | "desktop";

  launch(opts?: any): Promise<void>;
  close(): Promise<void>;
  checkAlive(): Promise<boolean>;
  ensureReady(): Promise<boolean>;
  focusWebview(): Promise<void>;
  reacquireAfterReload(): Promise<void>;
  getWindowInfo(): Promise<WindowInfo>;
  setWindowBounds(bounds: WindowBounds): Promise<void>;
  getPage(): Page;
  getWebviewFrame(): FrameLocator;
  getRawFrame(): Frame | null;
  getCamberWebviewFrame(): FrameLocator;
  getCamberRawFrame(): Frame | null;
  discoverPanels(): Promise<PanelInfo[]>;
  selectPanel(name: string): Promise<void>;
  getCurrentPanelName(): string;
  setRefMap(refs: Map<string, Locator>): void;
  resolveRef(selector: string): { locator: Locator } | { selector: string };
  setLastSnapshot(text: string | null): void;
  getLastSnapshot(): string | null;
  getWebIssues(opts?: { includeAll?: boolean; limit?: number; clear?: boolean }): WebIssue[];
  findLatestHelperLog(): string | null;
  findLatestHelperLogByName(helperLogName: string): string | null;
}
