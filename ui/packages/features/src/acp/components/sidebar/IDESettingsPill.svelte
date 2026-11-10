<script lang="ts">
  import { melt, type PopoverElements } from "@melt-ui/svelte";
  import Icon from "@camber/components/icon";
  import { suppressContextMenu } from "./contextMenuHelpers";

  type Trigger = PopoverElements["trigger"] extends import("svelte/store").Readable<infer T>
    ? T
    : never;

  interface Props {
    trigger: Trigger;
    active?: boolean;
  }

  let { trigger, active = false }: Props = $props();
</script>

<button
  type="button"
  use:melt={trigger}
  class={[
    "border-psx-button-secondary-border bg-psx-checkbox-background hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus text-psx-foreground-primary outline-hidden absolute bottom-4 right-4 z-20 flex w-fit items-center gap-1.5 rounded-full border px-2 py-1.5 text-left text-xs transition-colors duration-200 ease-out focus-visible:outline-2",
    active && "bg-psx-menu-hover-background text-psx-menu-active-foreground",
  ]}
  aria-label="Settings"
  oncontextmenu={suppressContextMenu}
>
  <Icon name="gear" size={16} />
  <span>Settings</span>
</button>
