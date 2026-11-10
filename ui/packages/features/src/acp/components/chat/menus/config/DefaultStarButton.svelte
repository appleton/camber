<script lang="ts">
  import Icon from "@camber/components/icon";

  interface Props {
    label: string;
    pressed: boolean;
    class?: string;
    onPress: () => void;
  }

  let { label, pressed, class: className, onPress }: Props = $props();

  // Pressed stars keep the vibrant color even while hovered — only unpressed
  // stars lift to the primary text color — so clicking shows the new default
  // immediately, without waiting for the pointer to leave.
  let starClass = $derived(
    [
      pressed
        ? "text-psx-vibrant opacity-100"
        : "text-psx-foreground-tertiary opacity-0 hover:text-psx-foreground-primary group-hover:opacity-100 group-focus-within:opacity-100",
      "hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus flex size-5 shrink-0 items-center justify-center rounded transition-opacity focus-visible:opacity-100 focus-visible:outline-2",
      className,
    ]
      .filter(Boolean)
      .join(" "),
  );

  function suppressPointerEvent(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    onPress();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    }
  }

  // Melt registers native listeners directly on each menu item, while Svelte's
  // event attributes are delegated to the document. Attach these handlers
  // natively too, so the star can stop the event before it reaches Melt and
  // schedules the menu to close.
  function keepMenuOpen(node: HTMLButtonElement): { destroy: () => void } {
    node.addEventListener("pointerdown", suppressPointerEvent);
    node.addEventListener("pointerup", suppressPointerEvent);
    node.addEventListener("click", handleClick);
    node.addEventListener("keydown", handleKeydown);

    return {
      destroy() {
        node.removeEventListener("pointerdown", suppressPointerEvent);
        node.removeEventListener("pointerup", suppressPointerEvent);
        node.removeEventListener("click", handleClick);
        node.removeEventListener("keydown", handleKeydown);
      },
    };
  }
</script>

<button
  type="button"
  aria-label={label}
  aria-pressed={pressed}
  title={pressed ? "Default" : "Make default"}
  class={starClass}
  use:keepMenuOpen
>
  <Icon name="star" size={13} />
</button>
