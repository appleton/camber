<script lang="ts">
  import { isAppleUser } from "@camber/components";
  import Kbd from "@camber/components/kbd";
  import * as Prompt from "@camber/components/prompt";
  import type { MouseEventHandler } from "svelte/elements";
  import Tooltip from "../ui/Tooltip.svelte";

  interface Props {
    canSteerPrompt: boolean;
    steerWithEnter: boolean;
    oncontextmenu?: MouseEventHandler<HTMLButtonElement>;
    tooltipOpenDelay?: number;
  }

  let { canSteerPrompt, steerWithEnter, oncontextmenu, tooltipOpenDelay = 500 }: Props = $props();

  const primaryAction = $derived(steerWithEnter ? "Steer" : "Enqueue");
  const modifiedEnterSymbol = isAppleUser() ? "⌘↵" : "Ctrl+↵";
</script>

<Tooltip placement="top" gutter={6} openDelay={tooltipOpenDelay}>
  {#snippet label()}
    <span class="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-left">
      <span>{canSteerPrompt ? "Steer" : "Interrupt & Send Now"}</span>
      <Kbd class="justify-self-end" label={steerWithEnter ? "↵" : modifiedEnterSymbol} />
      <span>Enqueue</span>
      <Kbd class="justify-self-end" label={steerWithEnter ? modifiedEnterSymbol : "↵"} />
    </span>
  {/snippet}
  <Prompt.Form.Submit icon="submit-solid" label={primaryAction} title="" {oncontextmenu} />
</Tooltip>
