<script lang="ts">
  import { Spinner } from "@camber/components/spinner";
  import { onMount, tick } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { extractErrorMessage } from "../../errors";
  import { nativeConfirmationRpc, type NativeConfirmationRPC } from "./nativeConfirmation";

  // Modal overlays must escape the caller's stacking and containing context:
  // a transformed or filtered ancestor (e.g. the sidebar's view slider or the
  // frosted vibrancy panels) reinterprets `fixed` as relative to itself,
  // pinning the dialog inside that region. Portal to <body> so the dialog is
  // app-global no matter where it is rendered from.
  const portalToBody: Attachment = (element) => {
    document.body.appendChild(element);
    return () => {
      element.parentNode?.removeChild(element);
    };
  };

  const dialogTitleId = $props.id();

  interface Props {
    title: string;
    description: string;
    /** Optional one-line detail (e.g. a file path) shown in a monospace row. */
    detail?: string;
    confirmLabel: string;
    /** Style the confirm button as destructive (red); native dialogs show a warning. */
    destructive?: boolean;
    onCancel: () => void;
    onConfirm: () => void | Promise<void>;
  }

  let {
    title,
    description,
    detail,
    confirmLabel,
    destructive = false,
    onCancel,
    onConfirm,
  }: Props = $props();
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let confirming = $state(false);
  let error = $state<string | null>(null);

  // On hosts with native OS confirmation dialogs (the desktop app), delegate
  // to the host instead of rendering the DOM modal. Read once on mount: the
  // capability cannot change while the dialog is open.
  const nativeRpc = nativeConfirmationRpc();
  let useNative = $state(nativeRpc !== undefined);

  onMount(() => {
    if (nativeRpc) {
      void runNative(nativeRpc);
      return;
    }
    void tick().then(() => cancelButton?.focus());
  });

  // A native dialog cannot stay open while `onConfirm` runs, so unlike the
  // DOM modal there is no in-dialog error state: failures surface in a
  // follow-up native error dialog and the confirmation is dismissed.
  async function runNative(native: NativeConfirmationRPC) {
    let confirmed: boolean;
    try {
      confirmed = await native.showNativeConfirmDialog({
        title,
        description: detail ? `${description}\n\n${detail}` : description,
        confirmLabel,
        destructive,
      });
    } catch (e) {
      // The host could not show the dialog (e.g. a missing dialog
      // permission); fall back to the DOM modal so the action still gets a
      // confirmation instead of silently cancelling.
      console.error("native confirmation dialog failed", e);
      useNative = false;
      void tick().then(() => cancelButton?.focus());
      return;
    }
    if (!confirmed) {
      onCancel();
      return;
    }
    confirming = true;
    try {
      await onConfirm();
    } catch (e) {
      const message = extractErrorMessage(e, "Unable to complete this action");
      await native.showNativeErrorDialog({ title, message }).catch(() => {});
      onCancel();
    }
  }

  async function confirm() {
    if (confirming) return;
    confirming = true;
    error = null;
    try {
      await onConfirm();
    } catch (e) {
      error = extractErrorMessage(e, "Unable to complete this action");
      confirming = false;
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (useNative) return;
    if (event.key === "Escape" && !confirming) onCancel();
  }}
/>

{#if !useNative}
  <div
    {@attach portalToBody}
    class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 px-4"
  >
    <div
      class="bg-psx-panel text-psx-foreground-primary shadow-overlay dark:shadow-overlay-dark w-full max-w-[380px] rounded-lg p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <h2 id={dialogTitleId} class="text-base font-semibold">{title}</h2>
      <p class="text-psx-foreground-secondary mt-2 text-sm/[20px]">{description}</p>

      {#if detail}
        <p
          class="bg-psx-chrome text-psx-foreground-secondary mt-3 truncate rounded-md px-2 py-1.5 font-mono text-xs"
          title={detail}
        >
          {detail}
        </p>
      {/if}

      {#if error}
        <p class="text-psx-error-foreground mt-3 text-[13px]/[18px]">{error}</p>
      {/if}

      <div class="mt-4 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 disabled:opacity-60"
          disabled={confirming}
          onclick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={confirming}
          class="outline-hidden focus-visible:outline-psx-focus inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 disabled:opacity-60 {destructive
            ? 'bg-psx-error-background text-psx-error-foreground hover:bg-psx-error-background/80'
            : 'bg-psx-button-primary-background text-psx-button-primary-foreground hover:bg-psx-button-primary-hover-background'}"
          onclick={() => void confirm()}
        >
          {#if confirming}<Spinner size={12} />{/if}
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
