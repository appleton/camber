import chokidar from "chokidar";
import { debounce } from "lodash";
import { serializeError } from "serialize-error";
import * as vscode from "vscode";
import { executeSetContextCommand, registerCommand } from "./api/commands";
import { affectsConfiguration, getCamberConfigurationSection } from "./api/configuration";
import * as apiProposals from "./apiProposals";
import { openPermissionSettings } from "./commands/openPermissionSettings";
import { getCamberConfig } from "./configuration";
import { sendActiveFileContext } from "./context";
import { DecorationProvider } from "./DecorationProvider";
import { ExtensionEnv, mapContextToExtensionMode } from "./env";
import { CAMBER, configureExtensionIdentity } from "./extensionIdentity";
import { getHelperSingleton, initializeHelperClient, updateHelperConfig } from "./helper";
import { getLanguages, serializeLanguages } from "./languages";
import { getKeybindingsWatchPaths } from "./rpc/handlers/getKeybindings";
import { openSettings } from "./rpc/handlers/openSettings";
import { getInitialKeybindings } from "./state";
import { createStatusBarItem } from "./statusBar";
import { System } from "./system";
import { TelemetryLogger } from "./telemetry/TelemetryLogger";
import { getActiveTheme, getParsedFileIconTheme } from "./theme";
import { AcpChatPanelSerializer, CAMBER_ACP_CHAT_VIEW_TYPE } from "./views/acpChatPanels";
import { updateEditorConfig } from "./views/getWebviewHtml";

/**
 * Pre-activation state, i.e. set before doActivate
 */
let telemetry: TelemetryLogger;
let system: System;

/**
 * Activate the extension on launch
 * @param context
 */
export async function activate(context: vscode.ExtensionContext) {
  configureExtensionIdentity(context.extension.id);

  telemetry = new TelemetryLogger();
  system = new System(context, telemetry, new DecorationProvider());

  try {
    await doActivate(system);
  } catch (error) {
    telemetry.reportError(serializeError(error));
  }
}

async function doActivate(system: System) {
  initializeHelperClient(system);

  system.context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      CAMBER_ACP_CHAT_VIEW_TYPE,
      new AcpChatPanelSerializer(system.acpChatPanels),
    ),
  );

  // Debounce the sendActiveFileContext function to avoid UI flickering
  const debouncedSendActiveFileContext = debounce(sendActiveFileContext, 150);

  vscode.window.onDidChangeActiveColorTheme(() => setActiveFileIconTheme());
  vscode.window.onDidChangeActiveTextEditor(() => debouncedSendActiveFileContext(system));
  vscode.window.onDidChangeTextEditorSelection(() => debouncedSendActiveFileContext(system));
  vscode.window.onDidChangeTextEditorVisibleRanges(() => debouncedSendActiveFileContext(system));
  vscode.window.onDidChangeWindowState((state) => {
    system.assistant.rpc.setEditorFocused(state.focused);
    system.acpChatPanels.setEditorFocused(state.focused);
  });

  vscode.workspace.onDidChangeConfiguration((e) => {
    handleConfigurationChange(e).catch((err) => {
      console.error("[camber] handleConfigurationChange error:", err);
    });
  });

  // Commands
  registerCommand("newConversation", () => openNewConversation(system));
  registerCommand("focusInput", () => focusInput(system));
  registerCommand("togglePlanMode", () => {
    system.acpChatPanels.togglePlanModeOnActivePanel();
  });
  registerCommand("showSidebar", () => system.assistant.showSidebar());

  // Always-visible launch affordance; the editor title button needs an open document
  system.context.subscriptions.push(createStatusBarItem());

  registerCommand("openPermissionSettings", () => {
    openPermissionSettings(system);
  });

  registerCommand("openSettings", () => {
    openSettings();
  });

  registerCommand("resetConfiguration", (_this) => {
    const workspaceConfig = getCamberConfigurationSection();

    if (!workspaceConfig) {
      return;
    }

    Object.keys(workspaceConfig).forEach((key) => {
      // read or modify the config
      const result = workspaceConfig.inspect(key);
      if (result) {
        workspaceConfig.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        workspaceConfig.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        workspaceConfig.update(key, undefined, vscode.ConfigurationTarget.Global);
      }
    });
  });

  // Proposed APIs (e.g. terminal data capture) require the `enable-proposed-api`
  // flag in argv.json. Skip in E2E as the test runner will fail if we do this.
  if (mapContextToExtensionMode(system.context) !== ExtensionEnv.test) {
    apiProposals.ensureEnabled(system).catch((err) => {
      system.telemetry.reportError(new Error("failed to enable proposed apis", { cause: err }));

      vscode.window.showErrorMessage(
        `camber: There was an error enabling proposed VSCode APIs in your ~/.vscode/argv.json: ${err.message}`,
      );
    });
  }

  // start camber Helper
  getHelperSingleton(system).catch((err) => {
    telemetry.reportError(new Error("failed to start camber Helper", { cause: err }));

    vscode.window.showErrorMessage(
      "camber: There was an error starting camber Helper, a required component. Functionality will be limited",
    );
  });

  system.context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      if (e.contentChanges.length > 0) {
        system.decorationProvider.deleteInserts(e.document.uri.fsPath);
      }
    }),
  );

  system.context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      debouncedSendActiveFileContext(system);
      system.decorationProvider.applyInserts();
    }),
  );

  // Notify the webview when the user updates their keybindings
  const shortcutWatcher = chokidar.watch(getKeybindingsWatchPaths());
  shortcutWatcher.on("all", sendKeybindings);
  system.context.subscriptions.push({ dispose: () => shortcutWatcher.close() });

  vscode.extensions.onDidChange(() => {
    const languages = getLanguages();
    const serializedLanguages = serializeLanguages(languages);
    system.assistant.rpc.setLanguages(serializedLanguages);
    system.acpChatPanels.setLanguages(serializedLanguages);
  });

  // This context key gates webview-only shortcuts until the assistant reports focus.
  executeSetContextCommand(`${CAMBER}.webviewFocus`, false);
}

async function setActiveFileIconTheme() {
  const theme = await getParsedFileIconTheme();
  if (!theme) return;
  system.assistant.rpc.setFileIconTheme(theme);
  system.acpChatPanels.setFileIconTheme(theme);
}

async function setColorTheme() {
  const theme = await getActiveTheme();
  if (!theme) return;
  system.assistant.rpc.setTheme(theme);
  system.acpChatPanels.setTheme(theme);
}

/**
 * Handle the configuration change event which is fired when the user changes their settings
 * @param e
 */
async function handleConfigurationChange(e: vscode.ConfigurationChangeEvent) {
  const camberConfig = getCamberConfig();

  if (e.affectsConfiguration(CAMBER)) {
    system.assistant.rpc.setConfiguration(camberConfig);
    system.acpChatPanels.setConfiguration(camberConfig);
    await updateHelperConfig(system);
  }

  if (affectsConfiguration(e, "camber.showKeybindings")) {
    await sendKeybindings();
  }

  if (e.affectsConfiguration("workbench.colorTheme")) {
    await setColorTheme();
  }

  if (e.affectsConfiguration("workbench.iconTheme")) {
    await setActiveFileIconTheme();
  }

  if (
    e.affectsConfiguration("editor.fontSize") ||
    e.affectsConfiguration("editor.lineHeight") ||
    affectsConfiguration(e, "camber.codeFontSize")
  ) {
    // FIXME: This needs to be tidied up
    if (system.assistant.webviewView === undefined) return;
    await updateEditorConfig(system, system.assistant.webviewView.webview);
  }
}

async function sendKeybindings() {
  const keybindings = await getInitialKeybindings();
  system.assistant.rpc.setKeybindings(keybindings);
  system.acpChatPanels.setKeybindings(keybindings);
}

/**
 * Deactivate the extension on close
 */
export async function deactivate() {
  const helper = await getHelperSingleton(system);
  await helper.sendNotification("shutdown");
  await helper.sendNotification("exit");
  await system.deactivate();
}

async function openNewConversation(system: System) {
  await system.acpChatPanels.openSession({});
}

async function focusInput(system: System) {
  await system.acpChatPanels.focusInput();
}
