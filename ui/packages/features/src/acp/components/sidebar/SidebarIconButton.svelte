<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import { suppressContextMenu } from "./contextMenuHelpers";

  interface Props {
    icon: IconName;
    label: string;
    title?: string;
    size?: number;
    buttonSize?: string;
    class?: string;
    disabled?: boolean;
    dragRegion?: boolean;
    onclick?: (event: MouseEvent) => void | Promise<void>;
  }

  let {
    icon,
    label,
    title,
    size = 18,
    buttonSize = "size-[22px]",
    class: className = "",
    disabled = false,
    dragRegion = false,
    onclick,
  }: Props = $props();
</script>

<button
  type="button"
  data-tauri-drag-region={dragRegion ? "false" : undefined}
  class={[
    "text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus flex shrink-0 items-center justify-center rounded-[6px] transition-colors ease-out focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
    buttonSize,
    className,
  ]}
  aria-label={label}
  {title}
  {disabled}
  {onclick}
  oncontextmenu={suppressContextMenu}
>
  <Icon name={icon} {size} />
</button>
