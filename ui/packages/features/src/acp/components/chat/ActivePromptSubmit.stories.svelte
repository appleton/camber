<script module lang="ts">
  import { defineMeta, type StoryContext } from "@storybook/addon-svelte-csf";
  import * as Prompt from "@camber/components/prompt";
  import type { ComponentProps } from "svelte";
  import ActivePromptSubmit from "./ActivePromptSubmit.svelte";

  type Args = ComponentProps<typeof ActivePromptSubmit>;

  const { Story } = defineMeta({
    title: "ACP/Chat/ActivePromptSubmit",
    component: ActivePromptSubmit,
    render: template,
    args: {
      canSteerPrompt: true,
      steerWithEnter: false,
      tooltipOpenDelay: 0,
    },
  });
</script>

{#snippet template(args: Args, _context: StoryContext<typeof ActivePromptSubmit>)}
  <div class="flex min-h-40 items-end justify-center p-8">
    <Prompt.Root class="w-[420px]" value="Focus on the failing test">
      <Prompt.Form.Root>
        <Prompt.Form.Field.Root>
          <Prompt.Form.Field.Editor.Root />
        </Prompt.Form.Field.Root>
        <Prompt.Form.Footer class="justify-end p-2">
          <ActivePromptSubmit
            canSteerPrompt={args.canSteerPrompt}
            steerWithEnter={args.steerWithEnter}
            tooltipOpenDelay={args.tooltipOpenDelay}
          />
        </Prompt.Form.Footer>
      </Prompt.Form.Root>
    </Prompt.Root>
  </div>
{/snippet}

<Story name="Enqueue with Enter" />

<Story name="Steer with Enter" args={{ steerWithEnter: true }} />

<Story name="Interrupt fallback" args={{ canSteerPrompt: false }} />
