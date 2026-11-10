<script lang="ts">
  import { getChips, getPrompt } from "@camber/components/prompt";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { getContextRepoContext } from "../../../context";
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import { attachFilePathToContext } from "../../prompt/menus/files/fileContextAttachment";
  import { DESKTOP_FILE_PROMPT_CHIP_EVENT } from "./desktopFilePromptChip";
  import { handleDesktopFilePromptChipEvent } from "./desktopFilePromptChipInserter";

  interface Props {
    enabled?: boolean;
  }

  let { enabled = true }: Props = $props();

  const { editor } = getPrompt();
  const chips = getChips();
  const contextRepo = getContextRepoContext();

  onMount(() => {
    const onInsertFileChip = (event: Event) => {
      handleDesktopFilePromptChipEvent(event, {
        enabled,
        editor: get(editor),
        chips,
        onInsertFile: (path) =>
          attachFilePathToContext(path, {
            contextRepo,
            helperSupported: Boolean($appState.isHelperSupported),
            rpc,
          }),
        onRemoveFile: (path) => {
          contextRepo.removeFile(path);
        },
      });
    };

    window.addEventListener(DESKTOP_FILE_PROMPT_CHIP_EVENT, onInsertFileChip);
    return () => window.removeEventListener(DESKTOP_FILE_PROMPT_CHIP_EVENT, onInsertFileChip);
  });
</script>
