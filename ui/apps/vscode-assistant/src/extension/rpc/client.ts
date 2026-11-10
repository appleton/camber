import {
  isError,
  type AssistantClient,
  type AssistantError,
  type AssistantResponse,
} from "@camber/rpc/assistant";
import { randomUUID } from "crypto";
import type { Event } from "vscode";

/**
 * A mockable interface which is a strict subset of System
 */
export interface WebviewHolder {
  webviewView?: {
    webview: Messenger;
  };
}

interface Messenger {
  postMessage(message: any): Thenable<boolean>;
  onDidReceiveMessage: Event<AssistantResponse | AssistantError>;
}

export const createRpcClient = function (system: WebviewHolder) {
  /**
   * An RPC client used to communicate from the VSCode extension context down to the VSCode webview
   * context.
   *
   * @implements {Client}
   */
  return new Proxy<AssistantClient>({} as AssistantClient, {
    get(_, method) {
      return function (...args: any[]) {
        return new Promise((resolve, reject) => {
          if (!system.webviewView) return resolve(null);

          const id = randomUUID();

          // Listen for the reply
          const listener = system.webviewView.webview.onDidReceiveMessage(
            (e: AssistantResponse | AssistantError) => {
              if (id !== e.payload.requestId) return;
              isError(e) ? reject(e.payload.error) : resolve(e.payload.response);
              listener?.dispose();
            },
          );

          // Send the request
          system.webviewView.webview.postMessage({ command: method, requestId: id, payload: args });
        });
      };
    },
  });
};
