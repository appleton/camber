import { setThemeContext } from "@camber/components/providers";
import { initializeACPHostRpc } from "@camber/features/acp";
import { onDestroy, onMount } from "svelte";

import { initializeStatefulModule as initializeHostRpc, rpc } from "../../../lib/rpc/client";
import { WebviewRPCServer } from "../../../lib/rpc/server";
import { appState, type CamberInitialState } from "../../../lib/store";
import type { Repositories } from "./Repositories.svelte";
import type { RuntimeProps } from "./types";

interface RegisterRpcServerOptions {
  props: RuntimeProps;
  repositories: Repositories;
  getActiveConversationId(): string | null;
}

// Initializes host/backend RPC and the theme context, then mounts the shared WebviewRPCServer.
export function registerRpcServer({
  props,
  repositories,
  getActiveConversationId,
}: RegisterRpcServerOptions) {
  const initialState: CamberInitialState = props.initialState ?? window.CAMBER_INITIAL_STATE;
  const theme = setThemeContext({
    colorTheme: initialState?.colorTheme,
    fileIconTheme: initialState?.fileIconTheme,
    getFileIconDefinition: (iconName) => rpc.getFileIconDefinition(iconName),
  });

  initializeHostRpc(props.rpcHostRequestHandler);
  initializeACPHostRpc(props.rpcHostRequestHandler);

  let rpcServer: WebviewRPCServer | undefined;

  onMount(() => {
    rpcServer = new WebviewRPCServer(
      props.webviewRpcListener ?? window,
      props.rpcWebViewResponseHandler,
      appState,
      repositories.elicitation,
      repositories.acpConnectionPool,
      repositories.acpContextRepo,
      repositories.assistantTerminals,
      repositories.acpRepo.publicAPI(),
      () => repositories.acpRepo.getSessionByConversationId(getActiveConversationId()),
      theme,
      repositories.acpProjectRepo,
      repositories.acpConversationRepo,
      repositories.localInference,
    );

    rpc.ready();
    rpc.setWebviewFocus(document.hasFocus());
  });

  onDestroy(() => {
    rpcServer?.dispose();
  });
}
