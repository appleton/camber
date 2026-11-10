import "./assistant.css";

import { ChatOnlyPanel, init } from "@camber/assistant";
import { mount } from "svelte";
import { installNotificationShim } from "./notificationShim";
import { rpcHostRequestHandler, rpcWebViewResponseHandler } from "./vs-handlers";

// The per-chat window: one webview per conversation, mounting the single-chat
// ChatOnlyPanel (vs the assistant sidebar's SidebarOnlyPanel). The host injects
// this window's CAMBER_INITIAL_ACP_CHAT_STATE, which ChatOnlyRuntime reads on mount.

// ChatOnlyRuntime calls acquireVsCodeApi() (a VSCode webview API) to persist panel
// state. Visual Studio's CefSharp webview has no such API, so provide a minimal
// in-memory shim before mount; without it the call throws and the window renders
// blank. We don't serialize panel state in VS, so getState/setState are enough.
let acpChatPanelState: unknown;
(globalThis as any).acquireVsCodeApi = () => ({
  getState: () => acpChatPanelState,
  setState: (state: unknown) => (acpChatPanelState = state),
  postMessage: () => {},
});

installNotificationShim();

const targetElement = document.getElementById("app");
const target = targetElement!;

init().then(() => {
  mount(ChatOnlyPanel, {
    target,
    props: {
      rpcHostRequestHandler,
      rpcWebViewResponseHandler,
    },
  });
});
