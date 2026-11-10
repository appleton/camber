<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect } from "storybook/test";
  import type { ComponentProps } from "svelte";
  import type { ACPAuthMethod } from "../authMethods";
  import { DEFAULT_AGENT_SERVER } from "../agentServers";
  import AuthRequiredPanel from "./AuthRequiredPanel.svelte";

  type Args = ComponentProps<typeof AuthRequiredPanel>;

  const terminalMethod: ACPAuthMethod = {
    type: "terminal",
    id: "camber-login",
    name: "Log in to Camber",
    description: "Authenticate with the Camber CLI.",
    command: "pool",
    args: ["login"],
  };

  const agentMethod: ACPAuthMethod = {
    type: "agent",
    id: "browser-login",
    name: "Continue in browser",
    description: "Complete authentication in your browser.",
  };

  const { Story } = defineMeta({
    title: "ACP/Auth Required Panel",
    component: AuthRequiredPanel,
    render: template,
    parameters: { layout: "fullscreen" },
    args: {
      agentServer: DEFAULT_AGENT_SERVER,
      agent: null,
      methods: [terminalMethod],
      inProgress: false,
      pendingTerminalAuthMethodId: null,
      onAuthenticate: () => {},
      onRetry: () => {},
    },
  });
</script>

{#snippet template(args: Args)}
  <div class="bg-psx-editor-background min-h-screen p-8">
    <div class="mx-auto w-full max-w-3xl">
      <AuthRequiredPanel {...args} />
    </div>
  </div>
{/snippet}

<Story name="Ready to log in" />

<Story
  name="Logging in"
  args={{
    pendingTerminalAuthMethodId: terminalMethod.id,
  }}
  play={async ({ canvas }) => {
    const retry = canvas.getByRole("button", { name: "Retry" });
    const action = canvas.getByRole("button", { name: terminalMethod.name });

    await expect(action).toBeDisabled();
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    await expect(canvas.queryByText("logging in")).toBeNull();
    await expect(retry.nextElementSibling).toBe(action);
  }}
/>

<Story
  name="Authentication in progress"
  args={{
    methods: [agentMethod],
    inProgress: true,
  }}
  play={async ({ canvas }) => {
    const retry = canvas.getByRole("button", { name: "Retry" });
    const action = canvas.getByRole("button", { name: agentMethod.name });

    await expect(action).toBeDisabled();
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    await expect(canvas.queryByText("logging in")).toBeNull();
    await expect(retry.nextElementSibling).toBe(action);
  }}
/>

<Story
  name="Authentication link available"
  args={{
    methods: [agentMethod],
  }}
  play={async ({ canvas }) => {
    const heading = canvas.getByRole("heading", {
      name: "Camber requires authentication before it can start a session.",
    });
    const action = canvas.getByRole("button", { name: agentMethod.name });
    const headingRect = heading.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    const centerOffset = Math.abs(
      actionRect.top + actionRect.height / 2 - (headingRect.top + headingRect.height / 2),
    );

    await expect(centerOffset).toBeLessThanOrEqual(1);
    await expect(canvas.queryByRole("button", { name: "Copy URL" })).toBeNull();
  }}
/>

<Story
  name="No advertised methods"
  args={{
    methods: [],
  }}
/>

<Story
  name="Awaiting login confirmation"
  args={{
    attemptedMethodId: terminalMethod.id,
    pendingTerminalAuthMethodId: terminalMethod.id,
  }}
  play={async ({ canvas }) => {
    const tryAgain = canvas.getByRole("button", { name: "Try again" });
    const confirm = canvas.getByRole("button", { name: "I'm logged in" });

    await expect(confirm).toBeEnabled();
    await expect(canvas.queryByRole("button", { name: terminalMethod.name })).toBeNull();
    await expect(tryAgain.nextElementSibling).toBe(confirm);
  }}
/>

<Story
  name="Verifying login confirmation"
  args={{
    attemptedMethodId: terminalMethod.id,
    confirmInProgress: true,
  }}
  play={async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "I'm logged in" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeDisabled();
    await expect(canvas.getByRole("status")).toBeInTheDocument();
  }}
/>
