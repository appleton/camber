<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import { appState } from "@camber/features/acp";

  import type { MobileAppearance, MobileThemePreference } from "./appearance";

  // Settings for the mobile app itself. These are phone-local (the host
  // persists them in the browser, not in the desktop app's settings) so the
  // phone can look different from the desktop it remote-controls.
  interface Props {
    appearance?: MobileAppearance;
  }

  let { appearance }: Props = $props();

  const THEME_OPTIONS: { value: MobileThemePreference; label: string; icon: IconName }[] = [
    { value: "system", label: "System", icon: "system" },
    { value: "light", label: "Light", icon: "light" },
    { value: "dark", label: "Dark", icon: "dark" },
  ];

  let theme = $state(appearance?.theme ?? "system");

  function selectTheme(value: MobileThemePreference) {
    theme = value;
    appearance?.onThemeChange(value);
  }

  const version = $derived($appState.environment.assistantVersion || "—");
</script>

<div
  class="flex-1 overflow-y-auto px-4 pb-8"
  style:padding-bottom="calc(2rem + env(safe-area-inset-bottom))"
>
  {#if appearance}
    <h2
      class="mt-5 mb-2 px-1 text-[13px] font-medium tracking-wide text-psx-foreground-secondary uppercase"
    >
      Appearance
    </h2>
    <div class="rounded-xl border border-psx-border/60 bg-psx-panel px-4 py-3.5">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[15px] text-psx-foreground-primary">Theme</span>
        <div
          class="flex shrink-0 rounded-full border border-psx-border/60 bg-psx-editor-background p-0.5"
          role="radiogroup"
          aria-label="Theme preference"
        >
          {#each THEME_OPTIONS as option (option.value)}
            <button
              type="button"
              role="radio"
              aria-checked={theme === option.value}
              class={[
                "flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[13px] outline-hidden focus-visible:outline-2 focus-visible:outline-psx-focus",
                theme === option.value
                  ? "bg-psx-chrome text-psx-foreground-primary shadow-low dark:shadow-low-dark"
                  : "text-psx-foreground-tertiary",
              ]}
              onclick={() => selectTheme(option.value)}
            >
              <Icon name={option.icon} size={14} aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          {/each}
        </div>
      </div>
      <p class="mt-2 mb-0 text-[12px] text-psx-foreground-tertiary">
        Only affects this device — the desktop app keeps its own theme.
      </p>
    </div>
  {/if}

  <h2
    class="mt-6 mb-2 px-1 text-[13px] font-medium tracking-wide text-psx-foreground-secondary uppercase"
  >
    About
  </h2>
  <div class="rounded-xl border border-psx-border/60 bg-psx-panel px-4">
    <div class="flex min-h-12 items-center justify-between gap-3">
      <span class="text-[15px] text-psx-foreground-primary">Version</span>
      <span class="text-[15px] text-psx-foreground-secondary">{version}</span>
    </div>
  </div>
</div>
