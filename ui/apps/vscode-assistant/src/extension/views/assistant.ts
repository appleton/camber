import { countAttentionConversations, type ACPNavConversation } from "@camber/features/acp/nav";
import type { AssistantClient } from "@camber/rpc/assistant";
import EventEmitter from "events";
import * as vscode from "vscode";
import { getCamberConfig } from "../configuration";
import { sendActiveFileContext } from "../context";
import { CAMBER } from "../extensionIdentity";
import { createRpcClient } from "../rpc/client";
import { HostRPCServer } from "../rpc/server";
import type { System } from "../system";
import { getWebviewHtml } from "./getWebviewHtml";

const CAMBER_WEBVIEW_VIEW_ID = `${CAMBER}-webview`;
const CAMBER_WEBVIEW_FOCUS_COMMAND = `${CAMBER_WEBVIEW_VIEW_ID}.focus`;

export enum AssistantState {
  // The webview has not yet been resolved or was disposed
  UNINITIALIZED = "uninitialized",
  // The webview is resolved and is initializing but not yet ready for RPC messages
  INITIALIZING = "initializing",
  // The webview is ready to receive RPC messages
  READY = "ready",
}

/**
 * Assistant encapsulates the initialization of the camber assistant webview, mediates RPC
 * communication and keeps track of the state.
 *
 * Always displayed in the sidebar as a WebviewView.
 */
export class Assistant implements vscode.WebviewViewProvider {
  static instance: Assistant;

  /**
   * create initializes the Assistant instance ensuring that it is a singleton
   */
  static create(system: System) {
    if (this.instance) throw new Error("assistant is already initialized");

    this.instance = new Assistant(system);

    system.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CAMBER_WEBVIEW_VIEW_ID, this.instance, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    return this.instance;
  }

  rpc: AssistantClient;
  state: AssistantState = AssistantState.UNINITIALIZED;

  webviewView: vscode.WebviewView | undefined;

  private rpcListenerDisposable: vscode.Disposable | undefined;
  private sidebarVisibilityDisposable: vscode.Disposable | undefined;
  private events: EventEmitter;
  private attentionCount = 0;
  // queue of callbacks to call when assistant becomes ready
  private onReady: Array<() => void> = [];

  constructor(readonly system: System) {
    this.events = new EventEmitter();
    this.rpc = createRpcClient(this);
    this.onDidChangeState((to, from) => {
      system.telemetry.log("assistant changed state", { from, to });

      if (to === AssistantState.READY) {
        this.callReadyCallbacks();
      }
    });
  }

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;

    webviewView.onDidDispose(() => {
      this.sidebarVisibilityDisposable?.dispose();
      this.sidebarVisibilityDisposable = undefined;
      this.webviewView = undefined;
      this.cleanupRpc();
      this.mark(AssistantState.UNINITIALIZED);
    });

    await this.initializeWebview(webviewView);
    this.updateAttentionBadge();

    this.sidebarVisibilityDisposable?.dispose();
    this.sidebarVisibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) this.system.decorationProvider.deleteAllInserts();
      sendActiveFileContext(this.system);

      const camberConfig = getCamberConfig();
      this.rpc.setConfiguration(camberConfig);
      this.system.acpChatPanels.setConfiguration(camberConfig);
    });
  }

  private cleanupRpc() {
    this.rpcListenerDisposable?.dispose();
    this.rpcListenerDisposable = undefined;
  }

  async refresh() {
    if (!this.webviewView) return;
    await this.initializeWebview(this.webviewView);
  }

  private async initializeWebview(webviewView: vscode.WebviewView) {
    this.mark(AssistantState.INITIALIZING);

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = await getWebviewHtml(this.system, webviewView.webview, "assistant");

    this.cleanupRpc();
    const rpcServer = new HostRPCServer(this.system, webviewView.webview);
    this.rpcListenerDisposable = webviewView.webview.onDidReceiveMessage(
      rpcServer.route.bind(rpcServer),
    );
  }

  /**
   * show ensures that the camber assistant webview is visible and ready to receive RPC messages.
   *
   * @returns a promise which resolves when the assistant webview is ready to receive RPC messages.
   */
  async show() {
    if (this.isReady) {
      return await vscode.commands.executeCommand(CAMBER_WEBVIEW_FOCUS_COMMAND);
    }

    const readyPromise = this.waitForReady();
    await vscode.commands.executeCommand(CAMBER_WEBVIEW_FOCUS_COMMAND);
    return readyPromise;
  }

  async showSidebar() {
    await this.show();
  }

  updateAttentionCount(conversations: readonly ACPNavConversation[] | null | undefined): void {
    this.attentionCount = countAttentionConversations(conversations ?? []);
    this.updateAttentionBadge();
  }

  updateAttentionBadge(): void {
    if (!this.webviewView) return;
    if (this.attentionCount === 0) {
      // Documentation says to assign badge = undefined. But that doesn't work.
      this.webviewView.badge = { value: 0, tooltip: "" };
      return;
    }
    this.webviewView.badge = {
      value: this.attentionCount,
      tooltip: `${this.attentionCount} conversation${this.attentionCount === 1 ? "" : "s"} ${this.attentionCount === 1 ? "needs" : "need"} attention`,
    };
  }

  private waitForReady(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const unregister = this.onDidChangeState((state: AssistantState) => {
        if (state === AssistantState.READY) {
          unregister();
          resolve();
        }
      });
    });
  }

  /**
   * mark is used to update the Assistant state
   */
  mark(state: AssistantState) {
    const prevState = this.state;
    this.state = state;
    this.events.emit("didChangeState", state, prevState);
  }

  get isReady() {
    return this.state === AssistantState.READY;
  }

  /**
   * onDidChangeState registers an event emitter which will be called each time the Assistant state
   * changes.
   *
   * @returns a function that can be called to unregister the event listener.
   */
  onDidChangeState(cb: (newState: AssistantState, prevState: AssistantState) => unknown) {
    this.events.on("didChangeState", cb);
    return () => {
      this.events.off("didChangeState", cb);
    };
  }

  // cb will be called either when assistant is ready, or on nextTick if already ready (i.e. will never be called sync)
  runWhenReady(cb: () => void) {
    if (this.state === AssistantState.READY) {
      process.nextTick(cb);
      return;
    }
    this.onReady.push(cb);
  }

  private callReadyCallbacks() {
    const toCall = this.onReady;
    this.onReady = [];
    for (const cb of toCall) {
      process.nextTick(cb);
    }
  }
}
