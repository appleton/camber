<script lang="ts">
  import { Dropdown as SharedDropdown } from "@camber/components/assistant-ui";
  import type { IconName } from "@camber/components/icon";
  import type { Snippet } from "svelte";

  interface Props {
    icon: IconName;
    iconClass?: string;
    label: string;
    placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
    header?: Snippet;
    children?: Snippet<[{ query: string }]>;
    searchable?: boolean;
    searchPlaceholder?: string;
    disableFocusFirstItem?: boolean;
    wide?: boolean;
    trigger?: Snippet<[{ open: boolean }]>;
    triggerClass?: string;
    triggerLabel?: string;
  }

  let {
    icon,
    iconClass,
    label,
    placement = "bottom-start",
    header,
    children,
    searchable = false,
    searchPlaceholder = "Search...",
    disableFocusFirstItem = false,
    wide = false,
    trigger,
    triggerClass,
    triggerLabel,
  }: Props = $props();
</script>

<SharedDropdown
  {icon}
  {iconClass}
  {label}
  {placement}
  {header}
  {searchable}
  {searchPlaceholder}
  {disableFocusFirstItem}
  {wide}
  {trigger}
  {triggerClass}
  {triggerLabel}
  {children}
/>
