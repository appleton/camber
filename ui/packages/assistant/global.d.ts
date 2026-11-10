import type { ColorTheme, FileIconTheme } from "@camber/components/providers";
import type { Configuration, Keybindings, WorkspaceFolder } from "@camber/rpc";
import type { Environment } from "./src/lib/store";

export default {};

/**
 * global adds a type definition for the window.CAMBER_APP_STATE variable
 * which is injected into the global scope of the webview window on start up.
 */
declare global {
  var CAMBER_INITIAL_STATE: {
    accessToken?: string | undefined;
    keybindings?: Keybindings;
    colorTheme?: ColorTheme;
    fileIconTheme?: FileIconTheme;
    userSettings?: Configuration;
    environment?: Environment;
    workspaces?: WorkspaceFolder[];
    homeDirectory?: string;
  };
  var CAMBER_INITIAL_ACP_CHAT_STATE:
    | {
        kind: "pending";
        conversationId: string;
        agentServer?: string;
        agentName?: string;
        agentIconUrl?: string;
        cwd?: string;
        workingDirectories?: string[];
      }
    | {
        kind: "session";
        conversationId: string;
        agentServer: string;
        sessionId: string;
        agentName?: string;
        agentIconUrl?: string;
        cwd?: string;
        workingDirectories?: string[];
        readOnly?: boolean;
        fallbackCwds?: string[];
      }
    | undefined;
  var CAMBER_ASSISTANT_VIEW_MODE: "classic" | "acp-sidebar" | undefined;
  function acquireVsCodeApi<T = unknown>(): {
    getState(): T | undefined;
    setState(state: T | undefined): void;
    postMessage(message: unknown): void;
  };
}
