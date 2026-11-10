import { DesktopPanel, init } from "@camber/assistant";
import {
  appState,
  desktopUpdate,
  NATIVE_MENU_SET_DEFAULT_EVENT,
  sidebarToasts,
  type ACPDebugAPI,
  type NativeMenuSetDefaultPayload,
  type Notifier,
} from "@camber/features/acp";
import { InfoMessageType } from "@camber/rpc";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  removeActive,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { mount } from "svelte";
import { startCamberQABridge } from "./camberqaBridge";
import {
  applyDesktopAccent,
  seedDesktopAccentFromCache,
  watchDesktopAccent,
} from "./desktopAccent";
import { loadDesktopBootstrap } from "./desktopBootstrap";
import DesktopFileViewerPanel from "./DesktopFileViewerPanel.svelte";
import {
  applyDesktopTheme,
  desktopColorTheme,
  watchDesktopTheme,
  type ResolvedDesktopTheme,
} from "./desktopTheme";
import { installExternalLinkHandler } from "./externalLinks";
import {
  acknowledgeHelperNotificationBatch,
  createWebviewResponseSender,
  DESKTOP_BUNDLE_REPLACED_EVENT,
  DESKTOP_CHECK_FOR_UPDATES_EVENT,
  DESKTOP_CLOSE_TAB_EVENT,
  DESKTOP_CLOSE_WINDOW_EVENT,
  DESKTOP_DEEP_LINK_EVENT,
  DESKTOP_FILE_TREE_CHANGED_EVENT,
  DESKTOP_NAVIGATE_BACK_EVENT,
  DESKTOP_NAVIGATE_FORWARD_EVENT,
  DESKTOP_NAVIGATION_AVAILABILITY_EVENT,
  DESKTOP_NEW_CONVERSATION_EVENT,
  DESKTOP_NEW_PROJECT_EVENT,
  DESKTOP_NEW_TAB_EVENT,
  DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT,
  DESKTOP_OPEN_FILE_TAB_EVENT,
  DESKTOP_OPEN_IN_IDE_EVENT,
  DESKTOP_OPEN_SETTINGS_PANEL_EVENT,
  DESKTOP_REOPEN_CLOSED_TAB_EVENT,
  DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT,
  DESKTOP_SELECT_NEXT_TAB_EVENT,
  DESKTOP_SELECT_PREVIOUS_TAB_EVENT,
  DESKTOP_SETTINGS_CHANGED_EVENT,
  DESKTOP_SPLIT_DOWN_EVENT,
  DESKTOP_SPLIT_RIGHT_EVENT,
  DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT,
  DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT,
  DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT,
  DESKTOP_UPDATE_PROGRESS_EVENT,
  DESKTOP_UPDATE_STAGED_EVENT,
  DesktopHost,
  getDesktopSettings,
  markHelperNotificationBridgeReady,
  MCP_OAUTH_CALLBACK_DEEP_LINK,
  openDesktopChangelog,
  refreshDesktopOpenersCache,
  setDesktopNavigationMenuEnabled,
  takePendingUpdateAnnouncement,
  TERMINAL_DID_CLOSE_EVENT,
  TERMINAL_DID_EXIT_EVENT,
  TERMINAL_DID_OPEN_EVENT,
  TERMINAL_DID_UPDATE_EVENT,
  TERMINAL_DID_WRITE_EVENT,
  type DesktopFileTreeChangedPayload,
  type DesktopOpenFileTabPayload,
  type DesktopSettings,
  type HelperJsonRpcNotificationBatchEvent,
  type HelperJsonRpcRequestEvent,
  type HelperNotificationBatchApplyResult,
} from "./rpc/host";
import { logStartupDiagnostic } from "./startupDiagnostics";
import { tauriDragDropSubscriber } from "./tauriDragDropSubscriber";
import {
  applyDownloadedUpdate,
  refreshBundleReplacedStatus,
  runManualUpdateCheck,
  startAutoUpdateLoop,
  updaterStatus,
} from "./updater";
import { getVSCodeFileIconDefinition, VSCODE_FILE_ICON_THEME } from "./vscodeFileIconTheme";
import { currentZoomLevel, installDesktopZoom } from "./zoom";

const HELPER_JSONRPC_REQUEST_EVENT = "camber:helper-jsonrpc-request";
const HELPER_JSONRPC_NOTIFICATION_BATCH_EVENT = "camber:helper-jsonrpc-notification-batch";
// Star-row clicks in an open native menu. native_menu.rs emits this with
// `emit_to`, targeted at the window that opened the menu, and
// presentNativeMenu matches payloads to its own request by `token`. Reception
// still goes through `currentWindow.listen`: Tauri's global `listen` observes
// every window's targeted emissions too, so only the window-scoped listener
// keeps another window's clicks out of this webview.
const NATIVE_MENU_SET_DEFAULT_TAURI_EVENT = "native-menu:set-default";
const DESKTOP_NOTIFICATION_CLICK_EVENT = "camber:desktop-notification-click";
const CLICKABLE_NOTIFICATIONS_UNSUPPORTED = "CLICKABLE_NOTIFICATIONS_UNSUPPORTED";
const DESKTOP_WINDOW_FULLSCREEN_CLASS = "desktop-window-fullscreen";
const TERMINAL_FONT_FALLBACK = 'Menlo, Monaco, Consolas, "Liberation Mono", monospace';
// Matches the --vscode-editor-font-family default stack in app.css.
const CODE_FONT_FALLBACK = 'Menlo, Monaco, Consolas, "Ubuntu Mono", "Liberation Mono", monospace';

// Tauri's fallback notification id is signed 32-bit, so keep generated ids in range.
const NOTIFICATION_ID_MAX = 2_147_483_647;

// Tag the document as macOS, and — when the "Translucent window" setting is on —
// as vibrancy-enabled, so app.css can clear the opaque top-level panel
// backgrounds and let the native window vibrancy (see src-tauri/src/navigation.rs)
// show through the grayish sidebar band. Non-macOS windows stay opaque, so the
// classes are only added on macOS. Done at module scope (before the async
// bootstrap) to avoid a flash of the wrong background before the first paint;
// the vibrancy class seeds from a localStorage mirror because the settings read
// below can wait seconds on helper startup, and is reconciled against the real
// setting in applyDesktopWindowVibrancy once settings load.
const isMacosPlatform = navigator.userAgent.includes("Macintosh");
const DESKTOP_WINDOW_VIBRANCY_CLASS = "desktop-vibrancy";
const DESKTOP_WINDOW_VIBRANCY_STORAGE_KEY = "camber-desktop-window-vibrancy";
if (isMacosPlatform) {
  document.documentElement.classList.add("platform-macos");
  if (localStorage.getItem(DESKTOP_WINDOW_VIBRANCY_STORAGE_KEY) !== "false") {
    document.documentElement.classList.add(DESKTOP_WINDOW_VIBRANCY_CLASS);
  }
  // Same reasoning as the vibrancy class above: seed from the cached accent so
  // the window does not flash the built-in blue before the bridge read lands.
  seedDesktopAccentFromCache();
}

interface TerminalWritePayload {
  terminalId: string;
  data: string;
}

interface TerminalUpdatePayload {
  terminalId: string;
  title?: string;
  cwd?: string;
}

interface TerminalExitPayload {
  terminalId: string;
  exitCode?: number;
}

interface TerminalClosePayload {
  terminalId: string;
}

interface DesktopInstanceInfo {
  worktreeName?: string;
  folderName?: string;
  color?: string;
}

function sendWebviewCommand(
  command: string,
  payload: unknown[],
  requestId: string = crypto.randomUUID(),
) {
  window.postMessage({ command, payload, requestId }, window.location.origin);
}

function dispatchDesktopCommand(eventName: string, detail?: unknown): boolean {
  const event = new CustomEvent(eventName, { cancelable: true, detail });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function setDesktopWindowFullscreenClass(fullscreen: boolean): void {
  document.body.classList.toggle(DESKTOP_WINDOW_FULLSCREEN_CLASS, fullscreen);
}

function applyDesktopWindowVibrancy(settings: DesktopSettings): void {
  if (!isMacosPlatform) return;
  localStorage.setItem(DESKTOP_WINDOW_VIBRANCY_STORAGE_KEY, String(settings.windowVibrancy));
  document.documentElement.classList.toggle(DESKTOP_WINDOW_VIBRANCY_CLASS, settings.windowVibrancy);
}

function applyDesktopFontPreferences(settings: DesktopSettings): void {
  lastFontSettings = settings;
  // The chat font variables are in px, so the rem-based root zoom does not
  // reach them; scale them by the zoom level here.
  const chatFontSize = settings.chatFontSize * currentZoomLevel();
  document.documentElement.style.setProperty("--psx-chat-font-size", `${chatFontSize}px`);
  // The markdown styles read --psx-text-leading for chat line height.
  document.documentElement.style.setProperty(
    "--psx-text-leading",
    `${chatLineHeightPx(chatFontSize)}px`,
  );
  document.documentElement.style.setProperty(
    "--vscode-terminal-font-family",
    terminalFontFamilyCssValue(settings.terminalFontFamily),
  );
  document.documentElement.style.setProperty(
    "--vscode-terminal-font-size",
    `${settings.terminalFontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--psx-terminal-cursor-style",
    settings.terminalCursorStyle,
  );
  // The code font preference drives the editor font variables, which
  // vscode.css forwards as --psx-font-mono / --psx-editor-font-size to every
  // code surface (diff view, chat code blocks). The file viewer receives the
  // same values via the environment state instead.
  document.documentElement.style.setProperty(
    "--vscode-editor-font-family",
    codeFontFamilyCssValue(settings.codeFontFamily),
  );
  const codeFontSize = Math.round(settings.codeFontSize);
  if (Number.isFinite(codeFontSize) && codeFontSize > 0) {
    document.documentElement.style.setProperty("--vscode-editor-font-size", `${codeFontSize}px`);
  } else {
    document.documentElement.style.removeProperty("--vscode-editor-font-size");
  }
}

// Chat text reads best around 1.5x leading; keep it proportional so larger
// font sizes get proportionally more breathing room.
function chatLineHeightPx(chatFontSize: number): number {
  return Math.round(chatFontSize * 1.5);
}

let lastFontSettings: DesktopSettings | undefined;
installDesktopZoom(() => {
  if (lastFontSettings) applyDesktopFontPreferences(lastFontSettings);
});

function terminalFontFamilyCssValue(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return TERMINAL_FONT_FALLBACK;
  if (trimmed.includes(",") || trimmed.toLocaleLowerCase().includes("monospace")) return trimmed;
  return `${trimmed}, ${TERMINAL_FONT_FALLBACK}`;
}

function codeFontFamilyCssValue(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return CODE_FONT_FALLBACK;
  if (trimmed.includes(",") || trimmed.toLocaleLowerCase().includes("monospace")) return trimmed;
  return `${trimmed}, ${CODE_FONT_FALLBACK}`;
}

const rpcWebViewResponseHandler = createWebviewResponseSender();

function camberqaDesktopInstance(): DesktopInstanceInfo | undefined {
  const params = new URLSearchParams(window.location.search);
  const color =
    params.get("camberqaColor") ?? (import.meta.env.VITE_CAMBERQA_COLOR as string | undefined);
  const worktreeName =
    params.get("camberqaWorktreeName") ??
    (import.meta.env.VITE_CAMBERQA_WORKTREE_NAME as string | undefined);
  const folderName =
    params.get("camberqaFolderName") ??
    (import.meta.env.VITE_CAMBERQA_FOLDER_NAME as string | undefined);
  if (!color && !worktreeName && !folderName) return undefined;

  const titleLabel = [folderName, worktreeName]
    .filter(
      (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
    )
    .join(" - ");
  if (titleLabel) {
    document.title = `Camber - ${titleLabel}`;
  }

  return {
    ...(color ? { color } : {}),
    ...(worktreeName ? { worktreeName } : {}),
    ...(folderName ? { folderName } : {}),
  };
}

interface StartOptions {
  onShellInteractive?: () => void;
  onInitialScreenSettled?: () => void;
}

export async function start({ onShellInteractive, onInitialScreenSettled }: StartOptions = {}) {
  logStartupDiagnostic("start.begin");
  const desktopInstance = camberqaDesktopInstance();
  let acpDebugAPI: ACPDebugAPI | undefined;
  startCamberQABridge(() => acpDebugAPI);

  const target = document.getElementById("app");

  if (!target) {
    throw new Error("App mount target not found");
  }

  const currentWindow = getCurrentWindow();
  const bootstrap = await loadDesktopBootstrap({
    readSettings: async () => {
      const settings = await getDesktopSettings({ boot: true });
      logStartupDiagnostic("start.desktopSettings");
      return settings;
    },
    readVersion: getVersion,
    readHomeDirectory: homeDir,
    prepareAppearance: async (settings) => {
      const theme = await applyDesktopTheme(settings.themePreference);
      applyDesktopFontPreferences(settings);
      applyDesktopWindowVibrancy(settings);
      logStartupDiagnostic("start.themeApplied");
      return theme;
    },
    reconcileAccent: async () => {
      // Both accent palettes are independent of the selected theme.
      await applyDesktopAccent();
      logStartupDiagnostic("start.accentApplied");
    },
    readWindowFocused: () => currentWindow.isFocused(),
    readWindowFullscreen: () => currentWindow.isFullscreen(),
  });
  let { desktopSettings, currentResolvedTheme, isWindowFocused, isWindowFullscreen } = bootstrap;
  const { assistantVersion, homeDirectory } = bootstrap;
  let currentThemePreference = desktopSettings.themePreference;
  logStartupDiagnostic("start.settingsLoaded", { assistantVersion });
  logStartupDiagnostic("start.windowProbed");
  setDesktopWindowFullscreenClass(isWindowFullscreen);
  let lastAttentionBadgeCount = -1;

  const initialState = {
    userSettings: {
      // Frozen persistence-scope key, NOT a real endpoint. The webview scopes
      // localStorage by this value (see ScopedPersistence); it must stay equal
      // to the historical default so existing users' persisted state stays
      // reachable. The desktop is ACP-only and has no configurable API URL.
      uri: "https://api.poolsi.de",
      themeOverride: null,
      wrapLines: false,
      showMermaidDiagrams: true,
      renderScan: false,
      highlightTelemetryElements: false,
      boolFeatures: {},
      notifyOnApproval: true,
    },
    environment: {
      assistantEnv: import.meta.env.DEV ? ("development" as const) : ("production" as const),
      assistantHost: "desktop",
      // Node process.platform identifiers, matching what the IDE hosts report
      // (VS Code passes process.platform; Visual Studio hard-codes "win32").
      // Native-menu gating (supportsNativeMenus) requires "darwin". The Tauri
      // webview has no process, so derive it from the engine's UA.
      operatingSystem: navigator.userAgent.includes("Mac")
        ? "darwin"
        : navigator.userAgent.includes("Windows")
          ? "win32"
          : "linux",
      assistantHostVersion: assistantVersion,
      assistantVersion,
      assistantProduct: "desktop-assistant",
      desktopInstance,
      desktopFileOpenerId: desktopSettings.fileOpenerId,
      desktopCodeFontFamily: desktopSettings.codeFontFamily,
      desktopCodeFontSize: desktopSettings.codeFontSize,
      desktopTerminalFontFamily: desktopSettings.terminalFontFamily,
      desktopTerminalFontSize: desktopSettings.terminalFontSize,
      desktopTerminalCursorStyle: desktopSettings.terminalCursorStyle,
      desktopToolActivity: desktopSettings.toolActivity,
      desktopSteerWithEnter: desktopSettings.steerWithEnter,
      desktopFullscreen: isWindowFullscreen,
      desktopOpeners: desktopSettings.desktopOpeners,
      capabilities: {
        header: true,
        fileContext: true,
        hostClipboardWrite: true,
        runTerminalCommands: false,
        terminalPanel: true,
        openWorkspace: false,
        addFolderToWorkspace: false,
        // CamberQA bridge flows that click through a confirmation disable
        // this per-flow (withDomConfirmationDialogs in camberqaBridge.ts) —
        // native dialogs are invisible to the bridge.
        nativeConfirmDialog: true,
      },
    },
    colorTheme: desktopColorTheme(currentResolvedTheme),
    fileIconTheme: VSCODE_FILE_ICON_THEME,
    workspaces: [],
    homeDirectory,
    keybindings: {},
    isHelperSupported: true,
    isEditorFocused: isWindowFocused,
  };

  const desktopHost = new DesktopHost(initialState, ({ command, payload, requestId }) =>
    sendWebviewCommand(command, payload, requestId),
  );
  desktopHost.setFileIconDefinitionResolver(getVSCodeFileIconDefinition);
  installExternalLinkHandler((url) => desktopHost.openExternalURL(url));

  function setDesktopFullscreen(fullscreen: boolean) {
    if (isWindowFullscreen === fullscreen) return;
    isWindowFullscreen = fullscreen;
    setDesktopWindowFullscreenClass(fullscreen);
    initialState.environment.desktopFullscreen = fullscreen;
    appState.update((state) => ({
      ...state,
      environment: {
        ...state.environment,
        desktopFullscreen: fullscreen,
      },
    }));
  }

  async function refreshDesktopFullscreen() {
    setDesktopFullscreen(await currentWindow.isFullscreen());
  }

  void currentWindow.onFocusChanged(({ payload: focused }) => {
    isWindowFocused = focused;
    desktopHost.setWebviewFocus(focused);
  });
  void currentWindow.onResized(() => {
    void refreshDesktopFullscreen();
  });

  const rpcHostRequestHandler = (method: string, args: unknown[]) =>
    desktopHost.handleHostRequest(method, args);

  void listen<DesktopSettings>(DESKTOP_SETTINGS_CHANGED_EVENT, (event) => {
    desktopSettings = event.payload;
    currentThemePreference = event.payload.themePreference;
    initialState.environment.desktopFileOpenerId = event.payload.fileOpenerId;
    initialState.environment.desktopCodeFontFamily = event.payload.codeFontFamily;
    initialState.environment.desktopCodeFontSize = event.payload.codeFontSize;
    initialState.environment.desktopTerminalFontFamily = event.payload.terminalFontFamily;
    initialState.environment.desktopTerminalFontSize = event.payload.terminalFontSize;
    initialState.environment.desktopTerminalCursorStyle = event.payload.terminalCursorStyle;
    initialState.environment.desktopToolActivity = event.payload.toolActivity;
    initialState.environment.desktopSteerWithEnter = event.payload.steerWithEnter;
    initialState.environment.desktopOpeners = event.payload.desktopOpeners;
    applyDesktopFontPreferences(event.payload);
    applyDesktopWindowVibrancy(event.payload);
    appState.update((state) => ({
      ...state,
      environment: {
        ...state.environment,
        desktopFileOpenerId: event.payload.fileOpenerId,
        desktopCodeFontFamily: event.payload.codeFontFamily,
        desktopCodeFontSize: event.payload.codeFontSize,
        desktopTerminalFontFamily: event.payload.terminalFontFamily,
        desktopTerminalFontSize: event.payload.terminalFontSize,
        desktopTerminalCursorStyle: event.payload.terminalCursorStyle,
        desktopToolActivity: event.payload.toolActivity,
        desktopSteerWithEnter: event.payload.steerWithEnter,
        desktopOpeners: event.payload.desktopOpeners,
      },
    }));
    window.dispatchEvent(
      new CustomEvent(DESKTOP_SETTINGS_CHANGED_EVENT, { detail: event.payload }),
    );
    void desktopHost.updateHelperConfig();
    void applyAndNotifyTheme(event.payload.themePreference);
  });

  void listen(DESKTOP_OPEN_SETTINGS_PANEL_EVENT, () => {
    void desktopHost.openSettings();
  });

  void listen(DESKTOP_NEW_CONVERSATION_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_NEW_CONVERSATION_EVENT);
  });

  void listen(DESKTOP_NEW_PROJECT_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_NEW_PROJECT_EVENT);
  });

  void listen(DESKTOP_OPEN_IN_IDE_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_OPEN_IN_IDE_EVENT);
  });

  void listen<string[]>(DESKTOP_DEEP_LINK_EVENT, (event) => {
    dispatchDesktopCommand(DESKTOP_DEEP_LINK_EVENT, event.payload);
  });

  void listen(DESKTOP_NEW_TAB_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_OPEN_CONVERSATION_SEARCH_EVENT, { initialQuery: "+" });
  });

  void listen(DESKTOP_CLOSE_TAB_EVENT, () => {
    if (!dispatchDesktopCommand(DESKTOP_CLOSE_TAB_EVENT)) {
      void currentWindow.close();
    }
  });

  void listen(DESKTOP_REOPEN_CLOSED_TAB_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_REOPEN_CLOSED_TAB_EVENT);
  });

  void listen<DesktopOpenFileTabPayload>(DESKTOP_OPEN_FILE_TAB_EVENT, (event) => {
    dispatchDesktopCommand(DESKTOP_OPEN_FILE_TAB_EVENT, event.payload);
  });

  void listen(DESKTOP_SPLIT_RIGHT_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_SPLIT_RIGHT_EVENT);
  });

  void listen(DESKTOP_SPLIT_DOWN_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_SPLIT_DOWN_EVENT);
  });

  void listen(DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT);
  });

  void listen(DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT);
  });

  void listen(DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT);
  });

  void listen(DESKTOP_SELECT_PREVIOUS_TAB_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_SELECT_PREVIOUS_TAB_EVENT);
  });

  void listen(DESKTOP_SELECT_NEXT_TAB_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_SELECT_NEXT_TAB_EVENT);
  });

  void listen(DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_SAVE_LAYOUT_AS_DEFAULT_EVENT);
  });

  void listen(DESKTOP_NAVIGATE_BACK_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_NAVIGATE_BACK_EVENT);
  });

  void listen(DESKTOP_NAVIGATE_FORWARD_EVENT, () => {
    dispatchDesktopCommand(DESKTOP_NAVIGATE_FORWARD_EVENT);
  });

  void listen(DESKTOP_CHECK_FOR_UPDATES_EVENT, () => {
    void runManualUpdateCheck(desktopHost);
  });

  window.addEventListener(DESKTOP_CLOSE_WINDOW_EVENT, () => {
    void currentWindow.close();
  });

  let navigationMenuUpdate = Promise.resolve();
  window.addEventListener(DESKTOP_NAVIGATION_AVAILABILITY_EVENT, (event) => {
    const detail = (event as CustomEvent<{ canGoBack?: boolean; canGoForward?: boolean }>).detail;
    navigationMenuUpdate = navigationMenuUpdate
      .then(() =>
        setDesktopNavigationMenuEnabled(detail?.canGoBack === true, detail?.canGoForward === true),
      )
      .catch((error) => {
        console.debug("Unable to update desktop navigation menu", error);
      });
  });

  window.addEventListener(DESKTOP_DEEP_LINK_EVENT, (event) => {
    const urls = (event as CustomEvent<string[]>).detail;
    if (!Array.isArray(urls)) return;
    for (const url of urls) {
      const isOAuthCallback =
        url === MCP_OAUTH_CALLBACK_DEEP_LINK || url.startsWith(`${MCP_OAUTH_CALLBACK_DEEP_LINK}?`);
      // An OAuth callback's query carries a live authorization code — log
      // only the redacted target, never the full URL.
      console.info(
        "camber: deep link received",
        isOAuthCallback ? `${MCP_OAUTH_CALLBACK_DEEP_LINK}?<redacted>` : url,
      );
      if (isOAuthCallback) {
        desktopHost.mcpOAuthCallback(url).catch((error) => {
          console.warn("camber: MCP OAuth deep-link callback failed", error);
          desktopHost.showInfoMessage(
            "Sign-in didn't complete — the connection may have timed out. Try connecting again.",
            InfoMessageType.error,
          );
        });
      }
    }
  });

  void listen<HelperJsonRpcRequestEvent>(HELPER_JSONRPC_REQUEST_EVENT, (event) => {
    void desktopHost.handleHelperRequest(event.payload);
  });

  // The native bridge retries an unacknowledged batch with the same id. Cache
  // both in-flight and completed application results so a lost acknowledgement
  // never causes an already-applied prefix to be delivered twice. Native
  // delivery is strictly serial, so once a newer id appears older ids cannot
  // be retried and this cache only needs a tiny bounded tail.
  const helperNotificationBatchResults = new Map<
    number,
    Promise<HelperNotificationBatchApplyResult>
  >();
  const applyHelperNotificationBatch = (event: HelperJsonRpcNotificationBatchEvent) => {
    const existing = helperNotificationBatchResults.get(event.id);
    if (existing) return existing;

    const result = desktopHost.handleHelperNotifications(event.notifications).catch(
      (error): HelperNotificationBatchApplyResult => ({
        applied: 0,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    helperNotificationBatchResults.set(event.id, result);
    while (helperNotificationBatchResults.size > 2) {
      const oldest = helperNotificationBatchResults.keys().next().value;
      if (oldest === undefined || oldest === event.id) break;
      helperNotificationBatchResults.delete(oldest);
    }
    return result;
  };

  void listen<HelperJsonRpcNotificationBatchEvent>(
    HELPER_JSONRPC_NOTIFICATION_BATCH_EVENT,
    (event) => {
      void applyHelperNotificationBatch(event.payload)
        .then((result) => {
          if (result.error) {
            console.error("Unable to apply full helper notification batch", result.error);
          }
          return acknowledgeHelperNotificationBatch(event.payload.id, result.applied);
        })
        .catch((error) => {
          console.error("Unable to report helper notification batch result", error);
        });
    },
  )
    .then(() => markHelperNotificationBridgeReady())
    .catch((error) => {
      console.error("Unable to initialize helper notification bridge", error);
    });

  void listen<DesktopFileTreeChangedPayload>(DESKTOP_FILE_TREE_CHANGED_EVENT, (event) => {
    window.dispatchEvent(
      new CustomEvent(DESKTOP_FILE_TREE_CHANGED_EVENT, { detail: event.payload }),
    );
  });

  // Scoped to this window: the native menu emits star clicks to the window
  // that opened it (`emit_to`), and presentNativeMenu matches them to its own
  // request by token.
  void currentWindow.listen<NativeMenuSetDefaultPayload>(
    NATIVE_MENU_SET_DEFAULT_TAURI_EVENT,
    (event) => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_MENU_SET_DEFAULT_EVENT, { detail: event.payload }),
      );
    },
  );

  void listen(TERMINAL_DID_OPEN_EVENT, (event) => {
    void sendWebviewCommand("assistantTerminalDidOpen", [event.payload]);
  });

  void listen<TerminalUpdatePayload>(TERMINAL_DID_UPDATE_EVENT, (event) => {
    void sendWebviewCommand("assistantTerminalDidUpdate", [event.payload]);
  });

  void listen<TerminalWritePayload>(TERMINAL_DID_WRITE_EVENT, (event) => {
    void sendWebviewCommand("assistantTerminalDidWrite", [event.payload]);
  });

  void listen<TerminalExitPayload>(TERMINAL_DID_EXIT_EVENT, (event) => {
    void sendWebviewCommand("assistantTerminalDidExit", [event.payload]);
  });

  void listen<TerminalClosePayload>(TERMINAL_DID_CLOSE_EVENT, (event) => {
    void sendWebviewCommand("assistantTerminalDidClose", [event.payload]);
  });

  const notificationCallbacks = new Map<number, () => void>();
  void listen<number>(DESKTOP_NOTIFICATION_CLICK_EVENT, (event) => {
    const callback = notificationCallbacks.get(event.payload);
    notificationCallbacks.delete(event.payload);
    void cancelDesktopNotification(event.payload);
    callback?.();
  });

  const notifier: Notifier = {
    isSupported: () => true,
    async ensurePermission() {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === "granted";
    },
    send({ title, body, onClick }) {
      const id = createNotificationId(notificationCallbacks);
      if (!isWindowFocused) {
        notificationCallbacks.set(id, onClick);
        void invoke<void>("send_clickable_notification", { id, title, body }).catch((error) => {
          if (!isClickableNotificationsUnsupported(error)) {
            console.error("failed to send clickable desktop notification", error);
          }
          notificationCallbacks.delete(id);
          sendNotification({ id, title, body, autoCancel: true });
        });
      }
      return () => {
        notificationCallbacks.delete(id);
        void cancelDesktopNotification(id);
      };
    },
  };

  await init();
  logStartupDiagnostic("start.mounting");
  let conversationsActive = false;
  let waitingToApply = false;
  mount(DesktopPanel, {
    target,
    props: {
      rpcHostRequestHandler,
      rpcWebViewResponseHandler,
      initialState,
      notifier,
      desktopFileViewerPanel: DesktopFileViewerPanel,
      tauriDragDropSubscriber,
      onShellInteractive,
      onInitialScreenSettled,
      onACPConnectionPoolReady: (pool) => {
        acpDebugAPI = pool.debug;
      },
      onACPAttentionCountChange: (count) => {
        if (count === lastAttentionBadgeCount) return;
        lastAttentionBadgeCount = count;
        void updateAttentionBadge(count);
      },
      onConversationActivityChange: (active) => {
        conversationsActive = active;
        if (!active) void finishWaitingUpdate();
      },
    },
  });

  logStartupDiagnostic("start.mounted");

  void refreshDesktopOpenersCache().catch((error) => {
    console.debug("Unable to refresh desktop openers cache", error);
  });

  // Background self-update (mirrors Studio): check shortly after launch, then
  // daily and download silently. The shared `desktopUpdate` store keeps
  // release-channel controls locked during an operation and, once staged,
  // renders the sidebar "Update" pill. Manual checks come through the "Check
  // for Updates…" app-menu item (DESKTOP_CHECK_FOR_UPDATES_EVENT above). The
  // loop is a no-op in dev — the real updater only runs in production builds
  // (see updater.ts).
  // Applying installs the staged update before restarting, so unlike the old
  // bare relaunch it can genuinely fail — a cancelled privilege prompt, a full
  // disk, a pulled release. The pill only re-enables itself, so report why.
  const finishWaitingUpdate = async () => {
    if (!waitingToApply || conversationsActive) return;
    waitingToApply = false;
    try {
      await applyDownloadedUpdate();
    } catch (error) {
      updaterStatus.update((status) =>
        status.kind === "downloaded" ? { ...status, waitingForIdle: false } : status,
      );
      desktopHost.showInfoMessage(
        "Couldn't install the update — the download is still available, so use the Update button to try again.",
        InfoMessageType.error,
      );
      console.error("failed to install update after conversations became idle", error);
    }
  };
  const applyUpdate = async () => {
    if (conversationsActive) {
      if (waitingToApply) return;
      waitingToApply = true;
      updaterStatus.update((status) =>
        status.kind === "downloaded" ? { ...status, waitingForIdle: true } : status,
      );
      return;
    }
    try {
      await applyDownloadedUpdate();
    } catch (error) {
      desktopHost.showInfoMessage(
        "Couldn't install the update — the download is still available, so use the Update button to try again.",
        InfoMessageType.error,
      );
      throw error;
    }
  };
  updaterStatus.subscribe((status) => {
    switch (status.kind) {
      case "downloaded":
        desktopUpdate.set({
          available: true,
          busy: false,
          version: status.version,
          notes: status.notes,
          waitingForIdle: status.waitingForIdle,
          apply: applyUpdate,
        });
        if (desktopSettings.autoInstallUpdates && !status.waitingForIdle && !import.meta.env.DEV) {
          queueMicrotask(() => void applyUpdate());
        }
        break;
      // The bundle on disk is already new; only this process is stale.
      case "replaced":
        desktopUpdate.set({ available: true, busy: false, apply: applyUpdate });
        break;
      default:
        desktopUpdate.set({
          available: false,
          busy: status.kind === "checking" || status.kind === "downloading",
          downloading: status.kind === "downloading",
          progress: status.kind === "downloading" ? status.progress : undefined,
        });
    }
  });
  window.addEventListener(DESKTOP_UPDATE_STAGED_EVENT, (event) => {
    const version = (event as CustomEvent<{ version: string }>).detail.version;
    updaterStatus.set({ kind: "downloaded", version });
  });
  void listen<{ downloaded: number; contentLength?: number }>(
    DESKTOP_UPDATE_PROGRESS_EVENT,
    (event) => {
      const { downloaded, contentLength } = event.payload;
      updaterStatus.update((status) => {
        if (status.kind !== "checking" && status.kind !== "downloading") return status;
        return {
          kind: "downloading",
          progress: contentLength ? downloaded / contentLength : undefined,
        };
      });
    },
  );
  // Raised when a native file panel was blocked because the bundle had already
  // been replaced on disk; show the same restart affordance.
  window.addEventListener(DESKTOP_BUNDLE_REPLACED_EVENT, () => {
    void refreshBundleReplacedStatus();
  });
  startAutoUpdateLoop();

  // Post-update toast: announce the freshly installed version once, linking to
  // the Changelog window. The host persists the announced version before
  // returning it, so a missed or dismissed toast never repeats.
  takePendingUpdateAnnouncement()
    .then((version) => {
      if (!version) return;
      sidebarToasts.addActionToast(
        `Updated to ${version}`,
        { label: "Changelog", onClick: () => void openDesktopChangelog() },
        { timeoutMs: 15_000 },
      );
    })
    .catch((error) => console.debug("post-update announcement failed", error));

  if (import.meta.env.DEV) {
    // Dev-only helpers (tree-shaken from production) to preview the sidebar
    // "Update" pill without cutting a real release — handy for iterating on the
    // UI. Nothing shows by default; trigger it with either:
    //   - ⌘⌥U to toggle the pill on/off, or
    //   - `window.__mockDesktopUpdate("1.2.3")` from the devtools console.
    // Clicking the pill relaunches without installing anything (dev builds
    // never stage an update — see applyDownloadedUpdate).
    const mockNotes = [
      "## Changes since 1.0.0",
      "",
      "### Improvements",
      "",
      "- Add third-party licenses to About (#539)",
      "",
      "### Fixes",
      "",
      "- Fix diff viewer cache collisions (#550)",
    ].join("\n");
    (
      window as unknown as {
        __mockDesktopUpdate?: (version?: string, notes?: string) => void;
        __mockDesktopUpdateProgress?: (progress?: number) => void;
        __mockDesktopUpdateWaiting?: (version?: string) => void;
      }
    ).__mockDesktopUpdate = (version = "0.0.0-mock", notes = mockNotes) =>
      updaterStatus.set({ kind: "downloaded", version, notes });
    (
      window as unknown as { __mockDesktopUpdateProgress?: (progress?: number) => void }
    ).__mockDesktopUpdateProgress = (progress) =>
      updaterStatus.set({ kind: "downloading", progress });
    (
      window as unknown as { __mockDesktopUpdateWaiting?: (version?: string) => void }
    ).__mockDesktopUpdateWaiting = (version = "0.0.0-mock") =>
      updaterStatus.set({ kind: "downloaded", version, waitingForIdle: true });
    window.addEventListener("keydown", (event) => {
      if (event.metaKey && event.altKey && event.code === "KeyU") {
        event.preventDefault();
        updaterStatus.update((status) =>
          status.kind === "downloaded"
            ? { kind: "idle" }
            : { kind: "downloaded", version: "0.0.0-mock", notes: mockNotes },
        );
      }
    });
  }

  watchDesktopTheme(
    () => currentThemePreference,
    (theme) => {
      notifyTheme(theme);
    },
  );

  watchDesktopAccent();
  logStartupDiagnostic("start.completed");

  async function applyAndNotifyTheme(themePreference: DesktopSettings["themePreference"]) {
    const theme = await applyDesktopTheme(themePreference);
    notifyTheme(theme);
  }

  function notifyTheme(theme: ResolvedDesktopTheme) {
    if (currentResolvedTheme === theme) return;
    currentResolvedTheme = theme;
    desktopHost.setColorTheme(desktopColorTheme(theme));
  }
}

function createNotificationId(callbacks: Map<number, () => void>): number {
  let id: number;
  do {
    id = crypto.getRandomValues(new Uint32Array(1))[0] % NOTIFICATION_ID_MAX;
  } while (callbacks.has(id));
  return id;
}

function isClickableNotificationsUnsupported(error: unknown): boolean {
  if (error === CLICKABLE_NOTIFICATIONS_UNSUPPORTED) return true;
  if (error instanceof Error) return error.message === CLICKABLE_NOTIFICATIONS_UNSUPPORTED;
  if (typeof error === "object" && error && "message" in error) {
    return error.message === CLICKABLE_NOTIFICATIONS_UNSUPPORTED;
  }
  return false;
}

async function cancelDesktopNotification(id: number): Promise<void> {
  try {
    await invoke("cancel_clickable_notification", { id });
  } catch (error) {
    if (!isClickableNotificationsUnsupported(error)) {
      console.error("failed to cancel clickable desktop notification", error);
    }
  }

  try {
    await removeActive([{ id }]);
  } catch {
    // Best-effort fallback cleanup for notifications sent through the Tauri plugin.
  }
}

async function updateAttentionBadge(count: number): Promise<void> {
  const badgeCount = count > 0 ? count : undefined;
  try {
    await getCurrentWindow().setBadgeCount(badgeCount);
  } catch (error) {
    console.error("failed to update desktop attention badge", error);
  }
}
