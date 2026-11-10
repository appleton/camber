<script lang="ts">
  import Icon from "@camber/components/icon";

  interface Props {
    label?: string;
    busy?: boolean;
    busyLabel?: string;
    onAddProject: () => void;
  }

  let {
    label = "add a new project to work with files",
    busy = false,
    busyLabel = "Fetching...",
    onAddProject,
  }: Props = $props();
</script>

<button
  type="button"
  aria-label="Add a project"
  class="dropzone border-psx-foreground-tertiary/50 bg-psx-editor-background/30 text-psx-foreground-primary hover:text-psx-vibrant outline-hidden hover:border-psx-vibrant/50 focus-visible:border-psx-vibrant/50 group mx-auto flex w-full max-w-sm flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed px-5 py-5 text-sm transition-[transform,border-color] duration-200 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60"
  disabled={busy}
  onclick={onAddProject}
>
  <span class="folder-glyph t-icon-swap h-8 w-8" aria-hidden="true">
    <span class="t-icon" data-icon="folder">
      <Icon name="folder" size={24} weight={0.85} class="folder-icon text-current" />
    </span>
    <span class="t-icon" data-icon="folder-plus">
      <Icon name="folder-plus" size={24} weight={0.85} class="folder-icon text-current" />
    </span>
  </span>
  <span class="text-sm">
    {busy ? busyLabel : label}
  </span>
</button>

<style lang="postcss">
  @reference "#tailwind.css";

  .dropzone:active {
    transform: translateY(1px);
  }

  .t-icon-swap {
    --icon-swap-dur: 200ms;
    --icon-swap-blur: 0;
    --icon-swap-start-scale: 0.82;
    --icon-swap-ease: ease-in-out;

    position: relative;
    display: inline-grid;
    place-items: center;
  }

  .t-icon-swap .t-icon {
    grid-area: 1 / 1;
    display: inline-flex;
    transition:
      opacity var(--icon-swap-dur) var(--icon-swap-ease),
      filter var(--icon-swap-dur) var(--icon-swap-ease),
      transform var(--icon-swap-dur) var(--icon-swap-ease);
    will-change: opacity, filter, transform;
  }

  .dropzone .t-icon-swap .t-icon[data-icon="folder"],
  .dropzone:not(:disabled):is(:hover, :focus-visible)
    .t-icon-swap
    .t-icon[data-icon="folder-plus"] {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
  }

  .dropzone .t-icon-swap .t-icon[data-icon="folder-plus"],
  .dropzone:not(:disabled):is(:hover, :focus-visible) .t-icon-swap .t-icon[data-icon="folder"] {
    opacity: 0;
    filter: blur(var(--icon-swap-blur));
    transform: scale(var(--icon-swap-start-scale));
  }

  @media (prefers-reduced-motion: reduce) {
    .t-icon-swap .t-icon {
      transition: none !important;
    }
  }
</style>
