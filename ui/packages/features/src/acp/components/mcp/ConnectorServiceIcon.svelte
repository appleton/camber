<script lang="ts">
  import logos from "./assets/connector-logos.json";
  import { connectorLogoNames as iconNames } from "./connectorLogoNames";
  import IconifyIcon from "@iconify/svelte";
  import Icon from "@camber/components/icon";
  import exaLogomarkURL from "./assets/exa-logomark.svg?url";
  import granolaLogomarkURL from "./assets/granola-logomark.svg?url";
  import parallelSymbolURL from "./assets/parallel-symbol.svg?url";

  interface Props {
    connectorID?: string | null;
    /** "xs" is a bare glyph for inline rows (e.g. the chat tool-call header). */
    size?: "xs" | "sm" | "md";
  }

  let { connectorID, size = "sm" }: Props = $props();

  type IconData = {
    body: string;
    width?: number;
    height?: number;
  };

  const officialLogoURLs: Record<string, string> = {
    "parallel-search": parallelSymbolURL,
    "exa-search": exaLogomarkURL,
    granola: granolaLogomarkURL,
  };

  const iconCollection = logos.icons as Record<string, IconData>;
  const defaultWidth = logos.width ?? 256;
  const defaultHeight = logos.height ?? 256;

  let normalizedID = $derived((connectorID ?? "").toLowerCase());
  let officialLogoURL = $derived(officialLogoURLs[normalizedID]);
  let icon = $derived.by(() => {
    const name = iconNames[normalizedID];
    const data = name ? iconCollection[name] : undefined;
    if (!data) return null;
    return {
      width: data.width ?? defaultWidth,
      height: data.height ?? defaultHeight,
      ...data,
    };
  });
  /* Brand marks are often solid black (GitHub, Vercel, Notion, Parallel), so
     the tile behind them must stay light in dark mode or they vanish. */
  let tileClass = "border-psx-border bg-psx-panel dark:border-black/10 dark:bg-white";
  let wrapperClass = $derived(
    size === "md"
      ? `${tileClass} size-10 rounded-xl border`
      : size === "sm"
        ? `${tileClass} size-8 rounded-[9px] border`
        : "size-4",
  );
  let iconSize = $derived(size === "md" ? "size-5" : size === "sm" ? "size-[18px]" : "size-3.5");
  let glyphSize = $derived(size === "md" ? 20 : size === "sm" ? 18 : 14);
  /* Fallback glyphs sit on the white tile in dark mode, so their dark-theme
     token colours (tuned for dark surfaces) need on-white overrides. The bare
     "xs" glyph has no tile and keeps the theme colours. */
  let onTile = $derived(size !== "xs");
  let wandClass = $derived(onTile ? "text-psx-link dark:text-psx-vibrant" : "text-psx-link");
  let mcpClass = $derived(
    onTile
      ? "text-psx-foreground-secondary dark:text-neutral-500"
      : "text-psx-foreground-secondary",
  );
</script>

<span class={["inline-grid shrink-0 place-items-center", wrapperClass]} aria-hidden="true">
  {#if officialLogoURL}
    <img src={officialLogoURL} alt="" class={iconSize} draggable={false} />
  {:else if icon}
    <IconifyIcon {icon} class={iconSize} mode="svg" />
  {:else if normalizedID === "canva"}
    <Icon name="wand" class={wandClass} size={glyphSize} />
  {:else}
    <Icon name="mcp" class={mcpClass} size={glyphSize} />
  {/if}
</span>
