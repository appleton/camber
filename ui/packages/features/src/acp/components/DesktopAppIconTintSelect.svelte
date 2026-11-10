<script lang="ts" module>
  /** Mirrors `AppIconTint` in src-tauri/src/app_icon.rs. */
  export type AppIconTint =
    | "default"
    | "blue"
    | "green"
    | "pink"
    | "orange"
    | "yellow"
    | "cyan"
    | "red";

  export const APP_ICON_TINTS: AppIconTint[] = [
    "default",
    "blue",
    "green",
    "pink",
    "orange",
    "yellow",
    "cyan",
    "red",
  ];
</script>

<script lang="ts">
  import blueURL from "./assets/app-icon-tints/blue.png?url";
  import cyanURL from "./assets/app-icon-tints/cyan.png?url";
  import defaultURL from "./assets/app-icon-tints/default.png?url";
  import greenURL from "./assets/app-icon-tints/green.png?url";
  import orangeURL from "./assets/app-icon-tints/orange.png?url";
  import pinkURL from "./assets/app-icon-tints/pink.png?url";
  import redURL from "./assets/app-icon-tints/red.png?url";
  import yellowURL from "./assets/app-icon-tints/yellow.png?url";

  interface Props {
    disabled?: boolean;
    value: AppIconTint;
    onChange?: (value: AppIconTint) => void;
  }

  // Rendered from the Icon Composer icon with the same hue rotation the app
  // applies at runtime (see src-tauri/src/app_icon.rs), so the swatch is what
  // the Dock will actually show. Regenerate these if the app icon changes.
  const OPTIONS: Array<{ value: AppIconTint; label: string; icon: string }> = [
    { value: "default", label: "Camber", icon: defaultURL },
    { value: "blue", label: "Blue", icon: blueURL },
    { value: "green", label: "Green", icon: greenURL },
    { value: "pink", label: "Pink", icon: pinkURL },
    { value: "orange", label: "Orange", icon: orangeURL },
    { value: "yellow", label: "Yellow", icon: yellowURL },
    { value: "cyan", label: "Cyan", icon: cyanURL },
    { value: "red", label: "Red", icon: redURL },
  ];

  let { disabled = false, value = $bindable(), onChange }: Props = $props();
</script>

<div class="grid w-[300px] grid-cols-4 gap-1" role="radiogroup" aria-label="App icon">
  {#each OPTIONS as option (option.value)}
    <label
      class={[
        "flex cursor-pointer items-center justify-center rounded-lg p-1 transition-colors",
        "hover:bg-psx-menu-hover-background has-[:checked]:bg-psx-highlight-background",
        "has-[:checked]:shadow-[inset_0_0_0_1px_var(--psx-highlight-border)]",
        "has-[:focus-visible]:outline-psx-focus has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
        disabled && "pointer-events-none opacity-60",
      ]}
      title={option.label}
    >
      <input
        class="sr-only"
        type="radio"
        name="appIconTint"
        {disabled}
        aria-label={option.label}
        value={option.value}
        bind:group={value}
        onchange={() => onChange?.(option.value)}
      />
      <img class="size-16" src={option.icon} alt="" />
    </label>
  {/each}
</div>
