<script lang="ts">
  import { DropdownSeparator as SharedDropdownSeparator } from "@camber/components/assistant-ui";

  interface Props {
    label?: string;
    index: number;
  }

  let { label, index }: Props = $props();
</script>

<SharedDropdownSeparator {label} {index} />
