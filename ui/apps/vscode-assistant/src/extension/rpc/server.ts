import {
  camberDeleteSecret,
  camberGetSecret,
  camberListSecrets,
  camberUpsertSecret,
} from "@camber/helperapi";
import type {
  ACPAgentServers,
  AcpChatPanelMetadata,
  AssistantTerminalCommandMode,
  AssistantTerminalTab,
  CloseAcpChatOptions,
  Host,
  HostMessage,
  OpenAcpChatOptions,
  TelemetryEventInputEventType,
  TelemetryEventInputMetadata,
} from "@camber/rpc";
import { randomUUID } from "crypto";
import { serializeError, type ErrorObject } from "serialize-error";
import * as vscode from "vscode";
import { executeSetContextCommand } from "../api/commands";
import { CAMBER } from "../extensionIdentity";
import { getHelperSingleton, updateHelperConfig } from "../helper";
import { System } from "../system";
import type { AcpChatPanels } from "../views/acpChatPanels";
import { assistantTerminalCommandLaunch } from "./assistantTerminalCommand";
import { addFolderToWorkspace } from "./handlers/addFolderToWorkspace";
import { checkFileExists } from "./handlers/checkFileExists";
import { getCodeSymbols } from "./handlers/getCodeSymbols";
import { getFileContents } from "./handlers/getFileContents";
import { getImageFileData } from "./handlers/getImageFileData";
import { getPromptContext } from "./handlers/getPromptContext";
import { getUrlContents } from "./handlers/getUrlContents";
import { listVSCodeMcpServers } from "./handlers/listVSCodeMcpServers";
import { openExternalURL } from "./handlers/openExternalURL";
import { openFile } from "./handlers/openFile";
import { openImageFile } from "./handlers/openImageFile";
import { openSettings } from "./handlers/openSettings";
import { openTerminal } from "./handlers/openTerminal";
import { openWorkspace } from "./handlers/openWorkspace";
import { ready } from "./handlers/ready";
import { reportError } from "./handlers/reportError";
import { reportEvent } from "./handlers/reportEvent";
import { revealSourceControl } from "./handlers/revealSourceControl";
import { saveTextFile } from "./handlers/saveTextFile";
import { selectProjectFolder } from "./handlers/selectProjectFolder";
import { showInfoMessage } from "./handlers/showInfoMessage";

export class HostRPCServer implements Host {
  private assistantTerminals = new Map<
    string,
    {
      terminal: vscode.Terminal;
      tab: AssistantTerminalTab;
      closeDisposable: vscode.Disposable;
      dataDisposable?: vscode.Disposable;
    }
  >();

  constructor(
    private system: System,
    private webview: vscode.Webview,
    private options: {
      acpChatPanels?: AcpChatPanels;
      getAcpChatPanelConversationId?: () => string;
    } = {},
  ) {}
  async getFileIconDefinition(_iconName: string): Promise<string | undefined> {
    return undefined;
  }

  async route({ command, payload, requestId }: HostMessage) {
    // Ignore non RPC messages
    const handler = this[command];
    if (typeof handler !== "function") {
      return;
    }

    try {
      //@ts-ignore
      const resp = await handler.apply(this, payload);
      if (requestId !== undefined) {
        this.webview.postMessage({ command, requestId, payload: resp });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.system.telemetry.reportError(serializeError(error), { tags: { hostRpc: command } });
      const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
      const data = "data" in error ? error.data : undefined;
      if (requestId !== undefined) {
        this.webview.postMessage({
          command,
          requestId,
          error: { message: error.message, code, data },
        });
      }
    }
  }

  checkFileExists = checkFileExists;
  getCodeSymbols = getCodeSymbols;
  openExternalURL = openExternalURL;
  openFile = openFile;
  openImageFile = openImageFile;
  getUrlContents = (url: string) => getUrlContents(this.system, url);
  getFileContents = getFileContents;
  getImageFileData = getImageFileData;
  getPromptContext = () => getPromptContext(this.system);
  openTerminal = (command?: string, cwd?: string) => openTerminal(this.system, command, cwd);
  async listAssistantTerminals(worktreePath: string): Promise<AssistantTerminalTab[]> {
    return Array.from(this.assistantTerminals.values())
      .filter(({ tab }) => tab.worktreePath === worktreePath)
      .map(({ tab }) => ({ ...tab }));
  }
  // VS Code terminals live in the editor's own panel, which sizes them itself,
  // so the optional cols/rows spawn size has no effect here.
  async createAssistantTerminal(
    worktreePath: string,
    command?: string,
    env?: Record<string, string>,
    commandMode?: AssistantTerminalCommandMode,
    cwd?: string,
  ): Promise<AssistantTerminalTab> {
    const id = `vscode-terminal-${Date.now()}-${this.assistantTerminals.size + 1}`;
    const resolvedCwd = cwd || worktreePath;
    const tab: AssistantTerminalTab = {
      id,
      title: `Terminal ${this.assistantTerminals.size + 1}`,
      cwd: resolvedCwd,
      worktreePath,
      createdAt: new Date().toISOString(),
    };
    const trimmedCommand = command?.trim();
    // `nonInteractive` is the legacy name for command-argument delivery. The
    // shell itself remains interactive (`-i`) so its normal rc files apply,
    // but the private Camber wrapper is never echoed as terminal input.
    const commandLaunch =
      commandMode === "nonInteractive" && trimmedCommand && !defaultTerminalProfileHasCustomLaunch()
        ? assistantTerminalCommandLaunch(vscode.env.shell, trimmedCommand)
        : undefined;
    const terminal = vscode.window.createTerminal({
      name: "camber",
      cwd: resolvedCwd || undefined,
      env,
      ...commandLaunch,
      iconPath: {
        dark: vscode.Uri.parse(
          this.system.context.asAbsolutePath("./dist/resources/icon-dark.svg"),
        ),
        light: vscode.Uri.parse(
          this.system.context.asAbsolutePath("./dist/resources/icon-light.svg"),
        ),
      },
    });
    const dataDisposable = this.captureTerminalData(id, terminal);
    const closeDisposable = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      this.assistantTerminals.delete(id);
      // With command-argument delivery the shell exits as soon as the command
      // finishes, and the completion-marker channel (proposal-gated terminal
      // data capture) may be unavailable or lose the race with this close
      // event — so forward the close-time exit status as the authoritative
      // exit-code source before announcing the close.
      this.webview.postMessage({
        command: "assistantTerminalDidExit",
        payload: [{ terminalId: id, exitCode: closed.exitStatus?.code }],
        requestId: randomUUID(),
      });
      this.webview.postMessage({
        command: "assistantTerminalDidClose",
        payload: [{ terminalId: id }],
        requestId: randomUUID(),
      });
      closeDisposable.dispose();
      dataDisposable?.dispose();
    });
    this.assistantTerminals.set(id, { terminal, tab, closeDisposable, dataDisposable });
    if (trimmedCommand && !commandLaunch) {
      terminal.sendText(trimmedCommand);
    }
    terminal.show();
    return tab;
  }
  async deleteAssistantTerminal(terminalId: string): Promise<void> {
    this.disposeAssistantTerminal(terminalId);
  }
  async writeAssistantTerminal(terminalId: string, data: string): Promise<void> {
    this.assistantTerminals.get(terminalId)?.terminal.sendText(data, false);
  }
  async clearAssistantTerminal(terminalId: string): Promise<void> {
    const entry = this.assistantTerminals.get(terminalId);
    if (!entry) return;
    // Drop the mirrored buffer and ask the shell to clear + redraw (Ctrl+L).
    entry.tab = { ...entry.tab, buffer: "" };
    entry.terminal.sendText("\f", false);
  }
  async resizeAssistantTerminal(_terminalId: string, _cols: number, _rows: number): Promise<void> {}
  async closeAssistantTerminalsForWorktree(worktreePath: string): Promise<void> {
    await this.closeMatchingAssistantTerminals((tab) => tab.worktreePath === worktreePath);
  }
  async closeAssistantTerminalsForProject(projectPath: string): Promise<void> {
    const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
    await this.closeMatchingAssistantTerminals(
      (tab) => tab.worktreePath === projectPath || tab.worktreePath.startsWith(prefix),
    );
  }
  showInfoMessage = showInfoMessage;
  async jsonrpc<I, O>(methodName: string, params: I): Promise<O> {
    const client = await getHelperSingleton(this.system);
    const result = await client.sendRequest(methodName, params);
    const conversationId = this.options.getAcpChatPanelConversationId?.();
    if (this.options.acpChatPanels && conversationId) {
      let sessionId: string | undefined;
      switch (methodName) {
        case "camber/acp/session/new":
          sessionId = sessionIdFromResult(result);
          break;
        case "camber/acp/session/load":
          sessionId = sessionIdFromParams(params);
          break;
        default:
          break;
      }
      if (sessionId) {
        this.options.acpChatPanels.attachSessionId(
          conversationId,
          agentServerFromParams(params),
          sessionId,
        );
      }
    }
    return result;
  }
  async jsonrpcNotify<I>(methodName: string, params: I): Promise<void> {
    const client = await getHelperSingleton(this.system);
    await client.sendNotification(methodName, params);
  }
  selectProjectFolder = selectProjectFolder;
  listVSCodeMcpServers = () => listVSCodeMcpServers(this.system);
  saveTextFile = saveTextFile;
  openWorkspace = openWorkspace;
  addFolderToWorkspace = addFolderToWorkspace;
  openSettings = openSettings;
  revealSourceControl = revealSourceControl;
  ready = () => {
    if (this.options.acpChatPanels) {
      const conversationId = this.options.getAcpChatPanelConversationId?.();
      if (conversationId) {
        this.options.acpChatPanels.panelReady(conversationId);
      }
      return;
    }
    return ready(this.system);
  };
  reportError = (error: ErrorObject) => reportError(this.system, error);
  reportEvent = (event: TelemetryEventInputEventType, data: TelemetryEventInputMetadata) => {
    reportEvent(this.system, event, data);
  };

  async setACPAgentServers(agentServers: ACPAgentServers, defaultAgentServer?: string) {
    const client = await getHelperSingleton(this.system);
    await client.sendRequest("camber/acpNav/setAgentServers", {
      agentServers,
      defaultAgentServer,
    });
    await updateHelperConfig(this.system);
  }

  async openAcpChat(opts: OpenAcpChatOptions): Promise<void> {
    await this.system.acpChatPanels.openSession(opts);
  }

  async closeAcpChat(opts: CloseAcpChatOptions): Promise<void> {
    this.system.acpChatPanels.closeSession(opts);
  }

  updateAcpChatPanelMetadata(metadata: AcpChatPanelMetadata): void {
    const conversationId = this.options.getAcpChatPanelConversationId?.();
    if (!conversationId || !this.options.acpChatPanels) return;
    this.options.acpChatPanels.updatePanelMetadata(conversationId, metadata);
  }

  private async closeMatchingAssistantTerminals(
    predicate: (tab: AssistantTerminalTab) => boolean,
  ): Promise<void> {
    for (const [id, { tab }] of this.assistantTerminals) {
      if (!predicate(tab)) continue;
      this.disposeAssistantTerminal(id);
    }
  }

  private disposeAssistantTerminal(terminalId: string): void {
    const entry = this.assistantTerminals.get(terminalId);
    if (!entry) return;
    entry.closeDisposable.dispose();
    entry.dataDisposable?.dispose();
    entry.terminal.dispose();
    this.assistantTerminals.delete(terminalId);
  }

  private captureTerminalData(
    terminalId: string,
    terminal: vscode.Terminal,
  ): vscode.Disposable | undefined {
    const onDidWriteTerminalData = (
      vscode.window as typeof vscode.window & {
        onDidWriteTerminalData?: (
          listener: (event: { terminal: vscode.Terminal; data: string }) => void,
        ) => vscode.Disposable;
      }
    ).onDidWriteTerminalData;
    if (!this.system.isApiProposalsEnabled() || !onDidWriteTerminalData) return undefined;
    return onDidWriteTerminalData((event) => {
      if (event.terminal !== terminal) return;
      const entry = this.assistantTerminals.get(terminalId);
      if (!entry) return;
      entry.tab = {
        ...entry.tab,
        buffer: `${entry.tab.buffer ?? ""}${event.data}`.slice(-200_000),
      };
      this.webview.postMessage({
        command: "assistantTerminalDidWrite",
        payload: [{ terminalId, data: event.data }],
        requestId: randomUUID(),
      });
    });
  }

  // We set context so that keybindings can be enabled only when the webview is focused
  setWebviewFocus(focused: boolean) {
    executeSetContextCommand(`${CAMBER}.webviewFocus`, focused);
  }

  upsertSecret = camberUpsertSecret;
  deleteSecret = camberDeleteSecret;
  listSecrets = camberListSecrets;
  getSecret = camberGetSecret;

  writeToClipboard(text: string): void {
    vscode.env.clipboard.writeText(text);
  }
}

// Command-argument delivery overrides the terminal profile's shellPath, which
// would silently drop any custom args/env the user's default profile defines
// (e.g. `--rcfile`, a nix/devbox wrapper). Restrict argv delivery to bare-path
// profiles; anything customized keeps the sendText fallback so the command
// still runs with the profile's full configuration.
function defaultTerminalProfileHasCustomLaunch(): boolean {
  const platformKey =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const config = vscode.workspace.getConfiguration("terminal.integrated");
  const profileName = config.get<string | null>(`defaultProfile.${platformKey}`);
  if (!profileName) return false;
  const profile = config.get<
    Record<string, { args?: string | string[]; env?: Record<string, string | null> } | null>
  >(`profiles.${platformKey}`)?.[profileName];
  if (!profile) return false;
  const hasArgs = Array.isArray(profile.args) ? profile.args.length > 0 : Boolean(profile.args);
  return hasArgs || Object.keys(profile.env ?? {}).length > 0;
}

function agentServerFromParams(params: unknown): string {
  if (params && typeof params === "object" && typeof (params as any).agentServer === "string") {
    return (params as any).agentServer;
  }
  return "camber";
}

function sessionIdFromResult(result: unknown): string | undefined {
  if (result && typeof result === "object" && typeof (result as any).sessionId === "string") {
    return (result as any).sessionId;
  }
  if (result && typeof result === "object" && typeof (result as any).session_id === "string") {
    return (result as any).session_id;
  }
}

function sessionIdFromParams(params: unknown): string | undefined {
  if (params && typeof params === "object" && typeof (params as any).sessionId === "string") {
    return (params as any).sessionId;
  }
}
