<script lang="ts">
  import { Button, type ButtonProps } from "@camber/components/button";
  import { isAppleUser } from "@camber/components";
  import Icon from "@camber/components/icon";
  import { get } from "svelte/store";
  import { appState } from "../../hostAdapter";
  import { markdownHost } from "../../markdownHost";

  interface Props extends ButtonProps {
    path: string;
    icon?: boolean;
  }

  let { path, icon = true, children, onclick, class: className, ...rest }: Props = $props();

  const click: ButtonProps["onclick"] = (event) => {
    void markdownHost.openFile?.(path, undefined, undefined, {
      preferredEditor: isExternalEditorClick(event),
    });
    onclick?.(event);
    event.stopPropagation();
  };

  function showContextMenu(event: MouseEvent) {
    if (
      !markdownHost.showFileContextMenu ||
      get(appState).environment.assistantHost !== "desktop"
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void markdownHost.showFileContextMenu({
      path,
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function isExternalEditorClick(event: MouseEvent) {
    return isAppleUser() ? event.metaKey : event.ctrlKey;
  }
</script>

<Button
  appearance="link"
  data-cursor="link"
  class={["truncate", className]}
  onclick={click}
  oncontextmenu={showContextMenu}
  {...rest}
  title={undefined}
>
  {#if icon}
    <Icon type="file" name={path} />
  {/if}

  <span class="truncate">
    {@render children?.()}
  </span>
</Button>
