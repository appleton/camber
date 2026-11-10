<script lang="ts">
  import Icon from "@camber/components/icon";
  import { InfoMessageType } from "@camber/rpc";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { sidebarToasts } from "./sidebarToastsState.svelte";

  interface Props {
    // Container classes; the parent controls placement, like SidebarLocalDownloads.
    class?: string;
  }

  let { class: containerClass = "" }: Props = $props();

  // Every mount renders the shared toasts (see sidebarToastsState.svelte.ts);
  // attach() refcounts the window listener across mounts.
  onMount(() => sidebarToasts.attach());

  function iconFor(type: InfoMessageType) {
    if (type === InfoMessageType.error) return "error";
    if (type === InfoMessageType.warning) return "alert";
    return "info";
  }
</script>

{#if sidebarToasts.toasts.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={containerClass}
    onpointerenter={() => sidebarToasts.suspendTimers()}
    onpointerleave={() => sidebarToasts.resumeTimers()}
  >
    {#each sidebarToasts.toasts as toast (toast.id)}
      <div transition:slide={{ duration: 200, axis: "y" }}>
        <div class="min-h-0 overflow-hidden">
          {#if toast.progress}
            <div
              class="text-psx-foreground-primary hover:bg-psx-menu-hover-background mt-1 flex w-full min-w-0 flex-col overflow-hidden rounded-lg bg-transparent transition-colors duration-300"
              role="status"
            >
              <div class="flex min-w-0 items-end gap-1">
                <div class="flex min-w-0 flex-1 flex-col gap-1 px-2 pb-1 pt-1.5">
                  <span
                    class="block h-1 w-full overflow-hidden rounded-full bg-gray-200"
                    role="progressbar"
                    aria-label={`${toast.message} progress`}
                  >
                    <span
                      class={[
                        "block h-full w-full origin-left rounded-full",
                        toast.progress.kind === "countdown"
                          ? "sidebar-toast-progress-countdown bg-blue-500"
                          : "",
                        toast.progress.kind === "indeterminate"
                          ? "sidebar-toast-progress-processing bg-blue-500"
                          : "",
                        toast.progress.kind === "error" ? "bg-psx-error-foreground" : "",
                      ]}
                      style:animation-duration={toast.progress.kind === "countdown"
                        ? `${toast.progress.durationMs}ms`
                        : undefined}
                    ></span>
                  </span>
                  <span
                    class={[
                      "min-w-0 max-w-full truncate text-[11px]/[14px]",
                      toast.type === InfoMessageType.error
                        ? "text-psx-error-foreground"
                        : "text-psx-foreground-secondary",
                    ]}
                  >
                    {toast.message}
                  </span>
                </div>
                {#if toast.action}
                  <button
                    type="button"
                    class="text-psx-foreground-secondary hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus mb-1 mr-1 flex h-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs focus-visible:outline-2"
                    aria-label={`${toast.action.label} ${toast.message.toLowerCase()}`}
                    onclick={() => sidebarToasts.runAction(toast.id)}
                  >
                    {toast.action.label}
                  </button>
                {/if}
              </div>
            </div>
          {:else}
            <div
              class="text-psx-foreground-primary hover:bg-psx-menu-hover-background mt-1 flex items-center gap-2 rounded-lg bg-transparent px-2 py-1.5 text-xs transition-colors duration-300"
              role="status"
            >
              <Icon
                name={iconFor(toast.type)}
                size={14}
                class={[
                  "shrink-0",
                  toast.type === InfoMessageType.error ? "text-psx-error-foreground" : "",
                  toast.type === InfoMessageType.warning ? "text-psx-warning-foreground" : "",
                  toast.type === InfoMessageType.info ? "text-psx-foreground-secondary" : "",
                ]}
              />
              <div class="min-w-0 flex-1 text-pretty break-words">
                {toast.message}
              </div>
              {#if toast.action}
                <button
                  type="button"
                  class="text-psx-foreground-secondary hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus flex h-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs focus-visible:outline-2"
                  aria-label={`${toast.action.label} ${toast.message.toLowerCase()}`}
                  onclick={() => sidebarToasts.runAction(toast.id)}
                >
                  {toast.action.label}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  @keyframes sidebar-toast-progress-countdown {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }

  @keyframes sidebar-toast-progress-processing {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  .sidebar-toast-progress-countdown {
    animation-name: sidebar-toast-progress-countdown;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }

  .sidebar-toast-progress-processing {
    animation: sidebar-toast-progress-processing 1.1s ease-in-out infinite;
  }
</style>
