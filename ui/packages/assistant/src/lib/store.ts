/**
 * @module AssistantStore
 * @description This module is written in a legacy style. Do not copy it. Instead, use repositories to manage state and persistence. Refer to ui/README.md for more.
 */

import type { ColorTheme, FileIconTheme } from "@camber/components/providers";
import { normalize } from "@camber/lib/path";
import type { Configuration, Keybindings, Language, WorkspaceFolder } from "@camber/rpc";
import { type Updater, writable, type Writable } from "svelte/store";

export const DEFAULT_URI = "https://api.poolsi.de";

export interface Capabilities {
  header: boolean;
  fileContext: boolean;
  customUI?: boolean;
  hostClipboardWrite?: boolean;
  runTerminalCommands?: boolean;
  terminalPanel?: boolean;
  openWorkspace?: boolean;
  addFolderToWorkspace?: boolean;
}

export interface Environment {
  assistantEnv: "development" | "test" | "production";
  assistantHost: string;
  assistantProduct?: string;
  assistantHostVersion: string;
  assistantVersion: string;
  operatingSystem?: string;
  desktopInstance?: DesktopInstanceInfo;
  capabilities: Capabilities;
}

export interface DesktopInstanceInfo {
  worktreeName?: string;
  folderName?: string;
  color?: string;
}

export interface CamberInitialState {
  accessToken?: string;
  keybindings?: Keybindings;
  colorTheme?: ColorTheme;
  fileIconTheme?: FileIconTheme;
  userSettings?: Configuration;
  environment?: Environment;
  workspaces?: WorkspaceFolder[];
  homeDirectory?: string;
  defaultCwd?: string;
  languages?: Language[];
  isAgenticMode?: boolean;
  isHelperSupported?: boolean;
  isEditorFocused?: boolean;
}

type AuthManagedInitialState = CamberInitialState & {
  identity?: unknown;
  is_tenant_admin?: boolean;
  isAuthenticated?: boolean;
  canAutoApproveCommands?: boolean;
  userAvatarBase64?: string;
  features?: unknown;
  [key: string]: unknown;
};

const initialAppState = {
  userSettings: {
    uri: DEFAULT_URI,
    themeOverride: null,
    wrapLines: false,
    showMermaidDiagrams: false,
    renderScan: false,
    highlightTelemetryElements: false,
    boolFeatures: {},
    notifyOnApproval: true,
  } as Configuration,
  environment: {
    assistantEnv: "development",
    assistantHost: "",
    assistantHostVersion: "",
    assistantVersion: "",
    capabilities: {},
  } as Environment,
  languages: [] as Language[],
  keybindings: {} as Keybindings,
  workspaces: [] as WorkspaceFolder[],
  homeDirectory: "",
  // Fallback cwd when no folder is open. Set by the host (e.g. VS Code
  // extension resolves $HOME). Empty in environments without a host.
  defaultCwd: "",
  isAgenticMode: false,
  isHelperSupported: false,
  isEditorFocused: true,

  ...stripAuthFields(globalThis.CAMBER_INITIAL_STATE),
};

export type AppState = typeof initialAppState;
export type AppStore = Writable<AppState>;

export const appState = writable(initialAppState);

// Resolves the cwd for new ACP sessions and history refreshes. Prefers the
// first open workspace folder, then the host-provided default (typically
// $HOME), then "/" as a last resort.
export function resolveSessionCwd(appState: Pick<AppState, "workspaces" | "defaultCwd">): string {
  return appState.workspaces[0]?.path || appState.defaultCwd || "/";
}

type AppStoreUpdates = {
  ensureWorkspaceForCwd: (cwd: string | null | undefined) => Updater<AppState>;
  setInitialState: (initial: CamberInitialState) => Updater<AppState>;
};

function workspaceName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function workspaceFromCwd(cwd: string | null | undefined): WorkspaceFolder | undefined {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd || normalize(trimmedCwd) === "/") return;

  return {
    path: trimmedCwd,
    name: workspaceName(trimmedCwd),
    index: -1,
  };
}

export const appStateUpdates = {
  setInitialState: (initial) => ($state) => {
    const nextState = stripAuthFields(initial);

    return {
      ...$state,
      ...nextState,
      userSettings: {
        ...$state.userSettings,
        ...(nextState.userSettings ?? {}),
      },
    };
  },
  ensureWorkspaceForCwd: (cwd) => ($state) => {
    if ($state.environment?.assistantHost === "desktop") return $state;
    if ($state.workspaces.some((workspace) => workspace.index >= 0)) return $state;

    const workspace = workspaceFromCwd(cwd);
    if (!workspace) return $state;

    if (
      $state.workspaces.some((existing) => normalize(existing.path) === normalize(workspace.path))
    ) {
      return $state;
    }

    return {
      ...$state,
      workspaces: [workspace],
    };
  },
} satisfies AppStoreUpdates;

// to keep appState's runtime fields matching its types, remove all
// fields now managed by AuthRepository
function stripAuthFields(
  initial: CamberInitialState | undefined,
): Omit<CamberInitialState, "accessToken"> {
  if (!initial) return {};
  const {
    accessToken: _accessToken,
    identity: _identity,
    is_tenant_admin: _isTenantAdmin,
    isAuthenticated: _isAuthenticated,
    canAutoApproveCommands: _canAutoApproveCommands,
    userAvatarBase64: _userAvatarBase64,
    features: _features,
    ...rest
  } = initial as AuthManagedInitialState;
  return rest as Omit<CamberInitialState, "accessToken">;
}
