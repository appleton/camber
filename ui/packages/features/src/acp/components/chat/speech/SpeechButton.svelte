<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { getDisplay } from "@camber/components/providers";
  import { onMount } from "svelte";
  import { getKeybindingService, withShortcut } from "../../../../keybindings";
  import { SpeechRecorder } from "./recorder";
  import { voiceInputStore } from "./voiceInputStore.svelte";

  interface Props {
    /** The composer is not accepting input (e.g. its agent needs authentication). */
    disabled?: boolean;
  }

  let { disabled = false }: Props = $props();

  const { customUI } = getDisplay();
  const keybindings = getKeybindingService();

  const mediaSupported = SpeechRecorder.supported();
  let phase = $derived(voiceInputStore.phase);
  let visible = $derived(mediaSupported && voiceInputStore.availability === "available");
  let ready = $derived(voiceInputStore.ready);
  let downloading = $derived(voiceInputStore.downloading);
  let downloadPercent = $derived.by(() => {
    const download = voiceInputStore.state?.download;
    if (!download?.bytesTotal) return null;
    return Math.min(100, Math.round(((download.bytesDownloaded ?? 0) / download.bytesTotal) * 100));
  });
  let label = $derived.by(() => {
    if (phase === "recording") return withShortcut("Stop and transcribe", "toggleDictation");
    if (phase === "transcribing") return "Transcribing…";
    if (downloading) {
      return downloadPercent == null
        ? "Downloading voice model…"
        : `Downloading voice model… ${downloadPercent}%`;
    }
    if (!ready) {
      return voiceInputStore.setupViaSettings
        ? "Set up voice recognition in Settings"
        : "Download voice model for dictation";
    }
    return withShortcut("Dictate", "toggleDictation");
  });

  onMount(() => {
    if (!mediaSupported) return;
    void voiceInputStore.ensureLoaded();
    return keybindings?.register("toggleDictation", () => void voiceInputStore.activate());
  });
</script>

{#if visible}
  <button
    type="button"
    class="speech-button {ready
      ? 'text-psx-icon'
      : 'text-psx-foreground-tertiary'} hover:bg-psx-chrome-hover focus-visible:border-psx-focus focus-visible:text-psx-focus active:bg-psx-chrome-active relative flex {customUI
      ? 'size-9 rounded-[14px] sm:size-[32px]'
      : 'size-[22px]'} {downloading
      ? ''
      : 'disabled:opacity-25'} focus:outline-hidden shrink-0 items-center justify-center rounded-full bg-transparent focus-visible:border disabled:pointer-events-none"
    class:recording={phase === "recording"}
    aria-label={label}
    aria-pressed={phase === "recording"}
    title={label}
    data-testid="prompt-speech-button"
    disabled={disabled || phase === "transcribing" || downloading}
    onclick={() => void voiceInputStore.activate()}
  >
    {#if downloading}
      <span
        class="download-ring"
        style="--speech-progress: {downloadPercent ?? 4}"
        aria-hidden="true"
      ></span>
    {/if}
    {#if phase === "transcribing" || downloading}
      <Spinner size={customUI ? 18 : 14} />
    {:else if phase === "recording"}
      <Icon aria-hidden="true" name="stop" size={customUI ? 24 : 20} />
    {:else}
      <Icon aria-hidden="true" name="microphone" size={customUI ? 20 : 16} />
    {/if}
  </button>
{/if}

<style lang="postcss">
  /* Determinate progress ring shown while the voice model downloads. */
  .download-ring {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: conic-gradient(
      var(--color-psx-focus) calc(var(--speech-progress) * 1%),
      color-mix(in srgb, var(--color-psx-focus) 20%, transparent) 0
    );
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
  }

  /* Accent (not error red): recording is a healthy state, the live waveform
     next to the button carries the "it's hearing you" feedback. */
  .speech-button.recording {
    color: var(--color-psx-focus);
    animation: speech-pulse 1.6s ease-out infinite;
  }

  @keyframes speech-pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-psx-focus) 45%, transparent);
    }
    70% {
      box-shadow: 0 0 0 7px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }
</style>
