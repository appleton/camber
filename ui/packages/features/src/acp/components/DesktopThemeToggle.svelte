<script lang="ts">
  import Icon from "@camber/components/icon";

  export type DesktopThemePreference = "system" | "light" | "dark";

  interface Props {
    disabled?: boolean;
    value: DesktopThemePreference;
  }

  const OPTIONS = [
    { value: "system", label: "System", icon: "system" },
    { value: "light", label: "Light", icon: "light" },
    { value: "dark", label: "Dark", icon: "dark" },
  ] as const;

  let { disabled = false, value = $bindable() }: Props = $props();
</script>

<div class="segmented-control" role="radiogroup" aria-label="Theme preference">
  {#each OPTIONS as option}
    <label class="option" class:disabled>
      <input
        class="sr-only"
        type="radio"
        name="themePreference"
        {disabled}
        value={option.value}
        bind:group={value}
      />
      <Icon name={option.icon} size={16} aria-hidden="true" />
      <span>{option.label}</span>
    </label>
  {/each}
</div>

<style lang="postcss">
  @reference "#tailwind.css";

  .segmented-control {
    @apply text-psx-foreground-tertiary shadow-(--shadow-border-inset) has-[:focus-visible]:outline-psx-focus dark:bg-(--color-mono-200) relative flex min-h-7 items-center rounded-full bg-white p-0.5 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2;
  }

  .option {
    @apply hover:text-psx-foreground-primary has-[:checked]:bg-(--color-mono-100) has-[:checked]:text-psx-foreground-primary has-[:checked]:shadow-(--shadow-border) dark:has-[:checked]:bg-(--color-mono-300) flex min-h-6 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-transparent px-2.5 text-xs transition-colors;
  }

  .option.disabled {
    @apply pointer-events-none opacity-60;
  }
</style>
