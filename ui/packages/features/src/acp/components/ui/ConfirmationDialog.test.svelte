<script lang="ts">
  import ConfirmationDialog from "./ConfirmationDialog.svelte";

  interface Props {
    error: unknown;
    detail?: string;
  }

  let { error, detail }: Props = $props();
</script>

<ConfirmationDialog
  title="Hand off to Camber?"
  description="A new Camber session will continue with context from this conversation."
  {detail}
  confirmLabel="Hand Off"
  onCancel={() => {}}
  onConfirm={() => Promise.reject(error)}
/>
