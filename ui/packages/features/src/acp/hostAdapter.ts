import { basename, normalize } from "@camber/lib/path";
import type { Configuration, Keybindings, Language, WorkspaceFolder } from "@camber/rpc";
import { get, writable, type Updater, type Writable } from "svelte/store";
import type { DesktopOpenerInfo } from "./desktopOpeners";

export interface Capabilities {
  header: boolean;
  fileContext: boolean;
  customUI?: boolean;
  hostClipboardWrite?: boolean;
  runTerminalCommands?: boolean;
  terminalPanel?: boolean;
  openWorkspace?: boolean;
  addFolderToWorkspace?: boolean;
  /**
   * The host shows OS-native confirmation dialogs via the
   * `showNativeConfirmDialog` / `showNativeErrorDialog` RPCs; when unset,
   * `ConfirmationDialog.svelte` renders a DOM modal instead.
   */
  nativeConfirmDialog?: boolean;
}

export interface DesktopInstanceInfo {
  worktreeName?: string;
  folderName?: string;
  color?: string;
}

export interface Environment {
  assistantEnv: "development" | "test" | "production";
  assistantHost: string;
  assistantProduct?: string;
  assistantHostVersion: string;
  assistantVersion: string;
  operatingSystem?: string;
  desktopInstance?: DesktopInstanceInfo;
  desktopFileOpenerId?: string;
  desktopCodeFontFamily?: string;
  desktopCodeFontSize?: number;
  desktopTerminalFontFamily?: string;
  desktopTerminalFontSize?: number;
  desktopTerminalCursorStyle?: string;
  desktopFullscreen?: boolean;
  desktopToolActivity?: "detailed" | "grouped" | "compact";
  desktopSteerWithEnter?: boolean;
  desktopOpeners?: DesktopOpenerInfo[];
  capabilities: Capabilities;
}

export interface ACPHostState {
  userSettings: Configuration;
  environment: Environment;
  languages: Language[];
  keybindings: Keybindings;
  workspaces: WorkspaceFolder[];
  homeDirectory?: string;
  defaultCwd: string;
  isHelperSupported: boolean;
  isEditorFocused?: boolean;
}

export type AppState = ACPHostState;
export type AppStore = Writable<AppState>;

const initialACPHostState: ACPHostState = {
  userSettings: {
    uri: "https://api.poolsi.de",
    themeOverride: null,
    wrapLines: false,
    showMermaidDiagrams: false,
    boolFeatures: {},
  } as Configuration,
  environment: {
    assistantEnv: "development",
    assistantHost: "",
    assistantHostVersion: "",
    assistantVersion: "",
    capabilities: {
      header: false,
      fileContext: false,
    },
  },
  languages: [],
  keybindings: {},
  workspaces: [],
  homeDirectory: "",
  defaultCwd: "",
  isHelperSupported: false,
  isEditorFocused: true,
};

let activeStore: Writable<AppState> = writable(initialACPHostState);
const activeStoreContainer = writable(activeStore);

export const appState: Writable<AppState> = {
  subscribe(run, invalidate) {
    let unsubscribeInner = activeStore.subscribe(run, invalidate);
    const unsubscribeOuter = activeStoreContainer.subscribe((nextStore) => {
      unsubscribeInner();
      unsubscribeInner = nextStore.subscribe(run, invalidate);
    });

    return () => {
      unsubscribeInner();
      unsubscribeOuter();
    };
  },
  set(value) {
    activeStore.set(value);
  },
  update(updater) {
    activeStore.update(updater);
  },
};

export function setACPHostStateStore<T extends AppState>(store: Writable<T>): void {
  activeStore = store as unknown as Writable<AppState>;
  activeStoreContainer.set(activeStore);
}

export interface ACPHostActions {
  trackClick?: (
    node: HTMLElement,
    parameter?: any,
  ) => void | { update?: (parameter?: any) => void; destroy?: () => void };
}

let hostActions: ACPHostActions = {};

export function setACPHostActions(actions: ACPHostActions): void {
  hostActions = actions;
}

export const appStateUpdates = {
  ensureWorkspaceForCwd:
    (cwd: string | null | undefined): Updater<AppState> =>
    (state) => {
      if (state.environment?.assistantHost === "desktop") return state;
      if (state.workspaces.some((workspace) => workspace.index >= 0)) return state;

      const workspace = workspaceFromCwd(cwd);
      if (!workspace) return state;
      if (
        state.workspaces.some((existing) => normalize(existing.path) === normalize(workspace.path))
      ) {
        return state;
      }

      return {
        ...state,
        workspaces: [workspace],
      };
    },
};

export function trackClick(node: HTMLElement, parameter?: any) {
  return hostActions.trackClick?.(node, parameter);
}

export function resolveSessionCwd(state: Pick<AppState, "workspaces" | "defaultCwd">): string {
  return state.workspaces[0]?.path || state.defaultCwd || "/";
}

function workspaceFromCwd(cwd: string | null | undefined): WorkspaceFolder | undefined {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd || trimmedCwd === "/") return;

  return {
    path: trimmedCwd,
    name: basename(trimmedCwd) || trimmedCwd,
    index: -1,
  };
}

export function currentACPHostState(): AppState {
  return get(appState);
}

// "Split" ACP hosts render the nav as a sidebar and each chat in its own window
// (driven via openAcpChat), rather than the desktop all-in-one shell. VS Code and
// Visual Studio both work this way; the desktop app does not.
export function isSplitACPHost(assistantHost: string | undefined): boolean {
  return assistantHost === "vscode" || assistantHost === "vs";
}
