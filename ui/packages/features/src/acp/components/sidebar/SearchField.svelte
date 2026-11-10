<script lang="ts">
  import Icon from "@camber/components/icon";
  import { appState, isSplitACPHost } from "../../hostAdapter";

  interface Props {
    value: string;
    placeholder: string;
    class?: string;
  }

  let { value = $bindable(), placeholder, class: className = "" }: Props = $props();
  let isIDE = $derived(isSplitACPHost($appState.environment.assistantHost));
</script>

<label class={["relative block min-w-0", className]}>
  <Icon
    name="search"
    size={14}
    class={[
      "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2",
      isIDE ? "text-psx-foreground-tertiary" : "text-psx-input-placeholder-foreground",
    ]}
    aria-hidden="true"
  />
  <input
    bind:value
    type="search"
    {placeholder}
    aria-label={placeholder}
    autocomplete="off"
    spellcheck="false"
    autocorrect="off"
    autocapitalize="off"
    class={[
      "outline-hidden focus-visible:outline-psx-focus h-8 w-full select-text rounded-full border px-2.5 pl-8 text-sm leading-4 focus-visible:outline-2",
      isIDE
        ? "border-psx-border bg-psx-editor-background text-psx-foreground-primary placeholder:text-psx-foreground-tertiary"
        : "border-psx-input-border bg-psx-input-background text-psx-input-foreground placeholder:text-psx-input-placeholder-foreground",
    ]}
  />
</label>
