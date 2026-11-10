import { initializeStatefulModule as initializeHelperClientRPC } from "@camber/helperapi";
import type {
  ACPElicitationOutput,
  ACPElicitationParams,
  ACPNavDidChangeParams,
} from "@camber/helperapi/schemas";
import os from "os";
import path from "path";
import vscode, { env } from "vscode";
import {
  CloseAction,
  type CloseHandlerResult,
  ErrorAction,
  type ErrorHandlerResult,
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  Message,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { getCamberConfig } from "./configuration";
import { getExtensionIdentity } from "./extensionIdentity";
import { _getValidHelperTarget } from "./helperUtils";
import { getDiagnostics } from "./lsp/handlers/getDiagnostics";
import { searchSymbolDefinitions } from "./lsp/handlers/searchSymbolDefinitions";
import { getEnvironment } from "./state";
import { System } from "./system";

/**
 * start launches an instance of the camber-helper binary and initializes communication via stdio.
 */
async function startHelper(system: System) {
  const { context } = system;
  const identity = getExtensionIdentity();

  let goRunDebug = {
    command: "go",
    args: ["run", "-tags=fts5", "./cmd/camber-helper/...", "--pprof"],
    transport: TransportKind.stdio,
    options: {
      cwd: context.asAbsolutePath("../../../"),
      env: process.env,
    },
  } satisfies Executable;

  const dlvBinary = vscode.workspace.getConfiguration("camberHelper").get("dlvBinary", "");
  if (dlvBinary) {
    const port = 21370;
    system.telemetry.log("debugging camber Helper via delve, connect debugger on port", { port });
    goRunDebug = {
      ...goRunDebug,
      command: dlvBinary,
      args: [
        // don't use --continue, it doesn't work with VSCode/Intellij
        "debug",
        "--continue",
        "--headless",
        `--listen=:${port}`,
        "--api-version=2",
        "--accept-multiclient",
        "--build-flags=-tags=fts5",
        `--log-dest=${path.join(os.tmpdir(), "camber-helper-dlv.log")}`, // can't write to stdout, or will error
        // "--log-dest=/tmp/camber-helper-dlv.log", // can't write to stdout, or will error
        // If you're having issues with delve itself, you can enable logging by uncommenting
        // the following lines:
        // "--log",
        // "--log-output=rpc",
        "./cmd/camber-helper",
        "--",
      ],
      options: {
        ...goRunDebug.options,
        env: {
          ...goRunDebug.options.env,
          CGO_CPPFLAGS: "-w", // this suppresses tree-sitter warnings, otherwise they break the communication
        },
      },
      transport: TransportKind.stdio,
    };
  }
  const serverOptions: ServerOptions = {
    run: {
      command: helperBinary(system),
      transport: TransportKind.stdio,
      options: {
        cwd: context.extensionPath,
      },
    },
    debug: goRunDebug,
  };

  const environment = getEnvironment(system);

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file" }],
    connectionOptions: {
      maxRestartCount: 100,
    },
    initializationOptions: {
      ...(await getRuntimeSettings()),
      sessionId: env.sessionId,
      assistantHost: environment.assistantHost,
      assistantEnvironment: environment.assistantEnv,
    },
    errorHandler: {
      error: (
        error: Error,
        message: Message | undefined,
        count: number | undefined,
      ): ErrorHandlerResult => {
        system.telemetry.log("server error", { error, message, count });
        return {
          action: ErrorAction.Continue,
          handled: true,
        };
      },
      closed: (): CloseHandlerResult => {
        system.telemetry.log("connection to server was closed, reconnecting", {});
        return {
          action: CloseAction.Restart,
          handled: true,
        };
      },
    },
    outputChannelName: identity.helperOutputChannelName,
  };

  // Set the following option in your settings.json to enable LSP tracing in the helper:
  //
  //     "camberHelper.trace.server": "verbose",
  if (vscode.workspace.getConfiguration("camberHelper").get("trace.server")) {
    clientOptions.traceOutputChannel = vscode.window.createOutputChannel(
      "camberHelper Language Server - Protocol Trace",
    );
  }

  const lspID = "camberHelper";
  const isDev = context.extensionMode === vscode.ExtensionMode.Development;
  const client = new LanguageClient(
    lspID,
    identity.helperOutputChannelName,
    serverOptions,
    clientOptions,
    isDev,
  );

  client.registerProposedFeatures();

  client.onRequest("camber/searchSymbolDefinitions", searchSymbolDefinitions);
  client.onRequest("camber/getDiagnostics", getDiagnostics);
  client.onRequest(
    "camber/acp/elicitation/create",
    (params: ACPElicitationParams): Promise<ACPElicitationOutput> => {
      return system.acpChatPanels.routeInbound(
        "camber/acp/elicitation/create",
        params,
      ) as Promise<ACPElicitationOutput>;
    },
  );
  client.onNotification(
    "camber/mcpOAuthURL",
    async (params: { serverID: string; authURL: string }) => {
      await vscode.env.openExternal(vscode.Uri.parse(params.authURL));
    },
  );
  client.onNotification("camber/acpNav/didChange", (params: ACPNavDidChangeParams) => {
    system.assistant.updateAttentionCount(params.state.conversations);
    system.acpChatPanels.acpNavDidChange(params.state);
    if (system.assistant.isReady) {
      void system.assistant.rpc.acpNavDidChange(params);
    }
  });

  client.onNotification("camber/jsonrpc/notify", (params: any) => {
    void system.acpChatPanels.routeInbound("camber/jsonrpc/notify", params);
  });

  client.onNotification("camber/acp/serverDidExit", (params: any) => {
    void system.acpChatPanels.routeInbound("camber/acp/serverDidExit", params);
  });

  client.onNotification("camber/acp/approvals/didChange", (params: any) => {
    void system.acpChatPanels.routeInbound("camber/acp/approvals/didChange", params);
  });

  client.onNotification("camber/mcpServers/didChange", (params: any) => {
    // Both the chat panels (live sessions to re-inject) and the sidebar (the
    // connectors UI) care about connector-store changes.
    void system.acpChatPanels.routeInbound("camber/mcpServers/didChange", params);
    if (system.assistant.isReady) {
      void system.assistant.rpc.mcpServersDidChange();
    }
  });

  client.onRequest("camber/jsonrpc/request", (params: any) => {
    return system.acpChatPanels.routeInbound("camber/jsonrpc/request", params);
  });

  await client.start();
  return client;
}

let running: LanguageClient | undefined;
let starting: Promise<LanguageClient> | undefined;
export async function getHelperSingleton(system: System): Promise<LanguageClient> {
  if (running) {
    return running;
  }
  if (!starting) {
    starting = startHelper(system);
    starting.then(
      (client) => {
        running = client;
      },
      (err) => {
        system.telemetry.reportError(new Error("failed to start daemon", { cause: err }));
      },
    );
  }
  return await starting;
}

function helperBinary(system: System) {
  const { platform, arch } = _getValidHelperTarget();
  const suffix = platform === "windows" ? ".exe" : "";
  return path.join(
    system.context.extensionPath,
    "dist",
    `camber-helper-${platform}-${arch}${suffix}`,
  );
}

// Based on /pkg/camber-helper/handler/config.go#Config. The assistant is
// ACP-chat-only, so the legacy auth/apiUrl/completion-model fields are gone.
async function getRuntimeSettings() {
  const camberConfig = getCamberConfig();

  return {
    agentServers: camberConfig.agentServers,
  };
}

/**
 * Notifies helper when configuration changes
 */
export async function updateHelperConfig(system: System) {
  try {
    const client = await getHelperSingleton(system);

    await client.sendRequest("workspace/didChangeConfiguration", {
      settings: {
        ...(await getRuntimeSettings()),
      },
    });
  } catch (e) {
    system.telemetry.reportError(
      new Error("failed to update config", {
        cause: e,
      }),
    );
  }
}

export function initializeHelperClient(system: System) {
  initializeHelperClientRPC({
    jsonrpcCall: async (method, params) => {
      const client = await getHelperSingleton(system);
      return await client.sendRequest(method, params);
    },
    jsonrpcNotify: async (method, params) => {
      const client = await getHelperSingleton(system);
      await client.sendNotification(method, params);
    },
  });
}
