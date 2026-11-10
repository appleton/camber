// The regular acquireVsCodeApi function throws an error if called more than once and it seems like
// the @estruyf/vscode/dist/client package does this. This is a workaround to ensure that this does
// not cause an error.
const vscodeAPI = acquireVsCodeApi<any>();
globalThis.acquireVsCodeApi = (() => vscodeAPI) as typeof acquireVsCodeApi;

import { SidebarOnlyPanel, init } from "@camber/assistant";
import { messageHandler } from "@estruyf/vscode/dist/client";
import { mount } from "svelte";
import "./assistant.css";

const targetElement = document.getElementById("app");
const target = targetElement!;

init().then(() => {
  mount(SidebarOnlyPanel, {
    target,
    props: {
      rpcHostRequestHandler: (method, args) => messageHandler.request(method.toString(), args),
      rpcWebViewResponseHandler: (_, payload) => messageHandler.send("rpc response", payload),
    },
  });
});
