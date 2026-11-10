<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { IconName } from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import TerminalOutputView from "../TerminalOutputView.svelte";
  import type { AcpSetupScriptOutput } from "../../features/SetupScriptOutputRepository.svelte";

  interface Props {
    output: AcpSetupScriptOutput;
    class?: string;
    onToggle?: () => void;
  }

  let { output, class: className, onToggle }: Props = $props();

  let open = $derived(!output.collapsed);
  let status = $derived.by(() => {
    if (output.status === "running") return "running";
    if (output.status === "failed") return "failed";
    if (output.status === "cancelled") return "cancelled";
    return undefined;
  });
  let title = $derived(output.status === "running" ? "worktree setup running" : "Setup script");
  let icon = $derived<IconName>(output.status === "completed" ? "terminal-done" : "terminal");
</script>

<div
  class={[
    "text-psx-foreground-secondary relative flex w-full max-w-full shrink-0 flex-col self-start text-left",
    className,
  ]}
>
  <button
    type="button"
    aria-expanded={open}
    aria-label={open ? "Collapse setup script output" : "Expand setup script output"}
    onclick={() => onToggle?.()}
    class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-pointer select-none items-center gap-1.5 self-start rounded-md py-0.5 pl-1.5 pr-2 text-xs transition-colors"
  >
    {#if output.status === "running"}
      <Spinner aria-hidden size={12} class="shrink-0" />
    {:else}
      <Icon name={icon} size={14} class="shrink-0" />
    {/if}
    <span class="shrink-0">{title}</span>
    {#if status && output.status !== "running"}
      <span class="shrink-0 uppercase opacity-80">{status}</span>
    {/if}
    <Icon
      name="chevron"
      class={[
        "ml-0.5 shrink-0 transition-all",
        !open && "-rotate-90 opacity-0 group-hover:opacity-100",
      ]}
    />
  </button>

  {#if open}
    <div class="relative flex max-w-full flex-col">
      <div class="border-psx-border bg-psx-panel overflow-hidden rounded-md border">
        <TerminalOutputView
          buffer={output.output}
          bufferStartOffset={output.outputStartOffset}
          placeholder="No output yet"
        />
      </div>
    </div>
  {/if}
</div>
