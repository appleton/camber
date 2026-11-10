<script module lang="ts">
  import { defineMeta, type StoryContext } from "@storybook/addon-svelte-csf";
  import type { SecretSummary } from "@camber/helperapi/schemas";
  import type { ComponentProps } from "svelte";
  import SecretsMenu from "./SecretsMenu.svelte";
  import SecretsMenuTestWrapper from "./SecretsMenuTestWrapper.svelte";

  type Args = ComponentProps<typeof SecretsMenuTestWrapper>;

  const defaultSecrets: SecretSummary[] = [
    {
      name: "NPM_TOKEN",
      description: "Token used for npm registry access",
      isRequired: true,
      isConfigured: true,
    },
    {
      name: "CUSTOM_API_KEY",
      description: "Custom project API key",
      isRequired: false,
      isConfigured: false,
    },
  ];

  const { Story } = defineMeta({
    title: "Prompt/Secrets/SecretsMenu",
    component: SecretsMenu,
    render: template,
  });
</script>

{#snippet template(args: Args, _context: StoryContext<typeof SecretsMenu>)}
  <SecretsMenuTestWrapper
    secrets={args.secrets}
    loading={args.loading}
    shouldFail={args.shouldFail}
    errorMessage={args.errorMessage}
  >
    <SecretsMenu />
  </SecretsMenuTestWrapper>
{/snippet}

<Story
  name="ShowsSuggestedAndCustomSecrets"
  args={{
    secrets: defaultSecrets,
    loading: false,
    shouldFail: false,
  }}
  play={async ({ canvas, step }) => {
    await step("renders sections and items from repository data", async () => {
      await canvas.findByText("Suggested by sandbox");
      await canvas.findByText("Custom secrets");
      await canvas.findByText("NPM_TOKEN");
      await canvas.findByText("CUSTOM_API_KEY");
      await canvas.findByRole("option", { name: /Add New Secret/i });
    });
  }}
/>

<Story
  name="ConfigureOpensEditMenu"
  args={{
    secrets: defaultSecrets,
    loading: false,
    shouldFail: false,
  }}
  play={async ({ canvas, userEvent, step }) => {
    await step("configure action opens the secret edit menu", async () => {
      await userEvent.click(await canvas.findByRole("option", { name: /NPM_TOKEN/i }));
      await canvas.findByTestId("secret-edit-panel");
    });
  }}
/>

<Story
  name="AddNewOpensEditMenu"
  args={{
    secrets: defaultSecrets,
    loading: false,
    shouldFail: false,
  }}
  play={async ({ canvas, userEvent, step }) => {
    await step("add new action opens the secret edit menu", async () => {
      await userEvent.click(await canvas.findByRole("option", { name: /Add New Secret/i }));
      await canvas.findByTestId("secret-edit-panel");
    });
  }}
/>

<Story
  name="LoadingState"
  args={{
    secrets: defaultSecrets,
    loading: true,
    shouldFail: false,
  }}
  play={async ({ canvas, step }) => {
    await step("shows loading state while secrets resolve", async () => {
      await canvas.findByText("Loading secrets...");
    });
  }}
/>

<Story
  name="EmptyState"
  args={{
    secrets: [],
    loading: false,
    shouldFail: false,
  }}
  play={async ({ canvas, step }) => {
    await step("shows add new secret item when there are no secrets", async () => {
      await canvas.findByRole("option", { name: /Add New Secret/i });
    });
  }}
/>

<Story
  name="ErrorState"
  args={{
    secrets: defaultSecrets,
    loading: false,
    shouldFail: true,
    errorMessage: "ERROR_READING_SECRET: keyring access denied",
  }}
  play={async ({ canvas, step }) => {
    await step("shows user-friendly failure message when loading secrets fails", async () => {
      await canvas.findByText(
        "Could not read a secret from your system keychain. Check keychain access and try again.",
      );
    });
  }}
/>
