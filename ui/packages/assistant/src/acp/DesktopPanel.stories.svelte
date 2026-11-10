<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { within } from "storybook/test";
  import DesktopPanel from "./DesktopPanel.svelte";
  import type { RPCError } from "@camber/rpc/generics";

  const { Story } = defineMeta({
    component: DesktopPanel,
  });

  // Create mock RPC handlers for Storybook
  function createMockHostRequestHandler() {
    return async (method: string, args: any) => {
      console.log("📞 RPC Call:", method, args);

      switch (method) {
        case "getConfiguration":
          return {
            uri: "https://api.poolsi.de",
            themeOverride: null,
            wrapLines: false,
            showMermaidDiagrams: false,
            boolFeatures: {},
            fontLigatures: false,
          };
        case "getContext":
          return {
            workspaces: [
              {
                path: "/test/workspace",
                name: "test-workspace",
                index: 0,
              },
            ],
            activeFile: {
              path: "/test/workspace/test.ts",
              content: "console.log('test');",
              selection: [0, 10],
              selectedCode: "console.log",
            },
          };
        case "jsonrpc":
          switch (args[0]) {
            case "camber/getUserConfig":
              return {
                settingsFilePaths: [],
              };
            default:
              return undefined;
          }
        case "ready":
          return undefined;
        case "promptModel":
          console.log("🚀 SUCCESS: promptModel called in Storybook!", args);
          return { promptId: "prompt-123" };
        case "getPromptContext":
          return [];
        default:
          console.log("⚠️ Unhandled RPC method:", method);
          return undefined;
      }
    };
  }

  function createMockWebViewResponseHandler() {
    return (command: string, response: { requestId: string; response?: any; error?: RPCError }) => {
      console.log("📤 WebView Response:", command, response);
    };
  }

  function createMockWebviewRpcListener() {
    return {
      addEventListener: (type: string, listener: EventListener) => {
        window.addEventListener(type, listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        window.removeEventListener(type, listener);
      },
    };
  }

  const mockInitialState = {
    accessToken: "ps-fake-token-123",
    isAuthenticated: true,
    environment: {
      assistantEnv: "development" as const,
      assistantHost: "storybook",
      assistantHostVersion: "1.0.0",
      assistantVersion: "1.0.0",
      capabilities: {
        demo: false,
        header: false,
        fileContext: true,
        customUI: false,
        hostClipboardWrite: false,
        runTerminalCommands: false,
      },
    },
  };
</script>

<Story
  name="DesktopPanel integration test - hello world"
  play={async ({ canvas, step, userEvent }) => {
    await step("send a prompt", async () => {
      const testMessage = "Hello from integration test!";

      const promptEditor = await canvas.findByTestId("prompt-input");
      await userEvent.click(promptEditor);

      await userEvent.type(promptEditor, testMessage);

      await userEvent.keyboard("{Enter}");

      const msgs = await canvas.findByTestId("chat-container-messages");
      // check we've rendered the message
      await within(msgs).findByText(testMessage);
    });
  }}
  args={{
    rpcHostRequestHandler: createMockHostRequestHandler(),
    rpcWebViewResponseHandler: createMockWebViewResponseHandler(),
    webviewRpcListener: createMockWebviewRpcListener(),
    initialState: mockInitialState,
  }}
/>
