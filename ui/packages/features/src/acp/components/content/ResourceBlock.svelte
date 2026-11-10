<script lang="ts">
  import type { EmbeddedResource } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";

  type Props = EmbeddedResource & {
    type: "resource";
  };

  let { resource }: Props = $props();

  let uri = $derived(resource.uri);
  let label = $derived(uri.split(/[\\/]/).filter(Boolean).at(-1) ?? uri);
</script>

<span
  class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark flex max-w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-sm"
>
  <Icon name="file" size={14} />
  <span class="min-w-0 truncate">{label}</span>
</span>
