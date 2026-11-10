<script lang="ts">
  import { DropdownItem as SharedDropdownItem } from "@camber/components/assistant-ui";
  import type { IconName } from "@camber/components/icon";
  import type { Snippet } from "svelte";

  interface Props {
    icon: IconName;
    iconClass?: string;
    label: string;
    description?: string | null;
    tag?: string;
    selected?: boolean;
    disabled?: boolean;
    onclick?: () => void;
    accessories?: Snippet;
  }

  let {
    icon,
    iconClass,
    label,
    description,
    tag,
    selected = false,
    disabled = false,
    onclick,
    accessories,
  }: Props = $props();
</script>

<SharedDropdownItem
  {icon}
  {iconClass}
  {label}
  {description}
  {tag}
  {selected}
  {disabled}
  {onclick}
  {accessories}
/>
