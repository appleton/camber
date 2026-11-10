<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import TextBlock from "./TextBlock.svelte";
  import AcpSessionProvider from "../../features/SessionProvider.svelte";
  import type { ComponentProps } from "svelte";

  const { Story } = defineMeta({
    component: TextBlock,
    render: template,
  });
</script>

{#snippet template(args: ComponentProps<typeof TextBlock>)}
  <AcpSessionProvider
    availableCommands={[
      { name: "plan", description: "Plan the next steps" },
      { name: "goal", description: "Set a goal to keep pursuing" },
      {
        name: "piano-composer",
        description: "Compose a piano piece",
        _meta: { "camber/slash_command_category": "skill" },
      },
    ]}
  >
    <TextBlock text={args.text} isUser={args.isUser ?? false} />
  </AcpSessionProvider>
{/snippet}

<Story
  name="Default"
  args={{
    text: [
      "ACP text supports `inlineCode`, **strong emphasis**, and regular _emphasis_.",
      "",
      "| Area | Status |",
      "| --- | --- |",
      "| Markdown | Styled through the classic path |",
      "| Tables | Match assistant table treatment |",
    ].join("\n"),
  }}
/>

<Story
  name="Slash command pill"
  args={{
    text: "Try running /plan to outline the work.",
    isUser: true,
  }}
/>

<Story
  name="Slash skill pill"
  args={{
    text: "Use /piano-composer for music tasks.",
    isUser: true,
  }}
/>

<Story
  name="Slash goal pill"
  args={{
    text: "/goal Ship the target icon everywhere",
    isUser: true,
  }}
/>

<Story
  name="Mixed slash tokens"
  args={{
    text: "Start with /plan and then call /piano-composer afterwards.",
    isUser: true,
  }}
/>

<Story
  name="Slash tokens inside paths are not pills"
  args={{
    text: [
      "Look at /folder/piano-composer and src/plan — neither should pill.",
      "",
      "But bare /plan and /piano-composer still pill.",
    ].join("\n\n"),
    isUser: true,
  }}
/>
