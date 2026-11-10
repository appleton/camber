<script lang="ts">
  import { run } from "svelte/legacy";
  import { type Chip, getChips, getMenus, getPrompt } from "../context/prompt.js";
  import { uniqueBy } from "@camber/lib/array";
  import { type Command, EditorState, Plugin } from "prosemirror-state";
  import { undo } from "prosemirror-history";
  import { markdownParser, schema } from "./schema.js";
  import { ChipNodeView } from "./chip/ChipNodeView.js";
  import type { KeyboardEventHandler } from "svelte/elements";
  import { get } from "svelte/store";
  import type { Snippet } from "svelte";
  import { chainCommands } from "prosemirror-commands";
  import {
    baseKeymap,
    clearStoredMarksPlugin,
    closeMatch,
    code,
    docHistory,
    Editor,
    exitTrailingCodeBlockBelow,
    loadDocsMeta,
    matchDecoration,
    nodeObserver,
    nativeMacWordNavigation,
    restoreNextDoc,
    restorePreviousDoc,
    selectionDecoration,
    tryMatch,
    undoHistory,
  } from "../../editor/index.js";
  import { keymap } from "prosemirror-keymap";
  import { getDisplay } from "../../../providers/index.js";
  import { insideModalOverlay } from "../../../utils/modalOverlay.js";
  import { handlePromptEscape } from "./promptEscape.js";

  interface Props {
    id?: string;
    plugins?: Plugin[];
    promptHistory?: string[];
    children?: Snippet;
  }

  let { id, plugins, promptHistory, children }: Props = $props();

  const {
    editor,
    isDirty,
    imeIsComposing,
    isSubmitting,
    disabled,
    submit,
    submitNow,
    interrupt,
    acceptSuggestion,
    submitSuggestion,
    onEditorUpdate,
    elements: { listId, labelId },
  } = getPrompt();

  const { rules, menu, depth, pop } = getMenus();

  const chips = getChips();

  let isDefault = $state(true);

  run(() => {
    $isDirty = !isDefault;
  });

  const chipObserver = nodeObserver({
    filter: (node) => node.type === schema.nodes.chip,
    getNodeDetail: (node, pos) => ({
      id: node.attrs.id as Chip["id"],
      value: node.attrs.value as Chip["content"]["value"],
      node,
      pos,
    }),
    onInsertNodes(details) {
      uniqueBy(details, ({ value }) => value).forEach((detail) => {
        const { id } = detail;
        const chip = chips.get(id);
        if (!chip) return;

        const { onInsert, content } = chip;

        onInsert?.(content, {
          undo: () => {
            $editor?.executeCommand(undo);
          },
        });
      });
    },
    onRemoveNodes(details, { siblings }) {
      // Skip during submission to preserve context between messages
      if ($isSubmitting) return;

      uniqueBy(details, ({ value }) => value).forEach(({ id, value }) => {
        const hasDuplicate = siblings.some(({ node }) => node.attrs.value === value);
        if (hasDuplicate) return;
        const chip = chips.get(id);
        if (!chip) return;
        const { onRemove, content } = chip;
        onRemove?.(content.value);
      });
    },
  });

  function parsePrompt(text: string) {
    try {
      return markdownParser.parse(text);
    } catch {
      return schema.node("doc", null, [
        schema.node("paragraph", null, text ? [schema.text(text)] : []),
      ]);
    }
  }

  $effect(() => {
    if (!promptHistory?.length) return;
    const ed = get(editor);
    if (!ed) return;
    const docs = promptHistory.map(parsePrompt);
    ed.executeCommand((state, dispatch) => {
      dispatch?.(loadDocsMeta(state.tr, docs));
      return true;
    });
  });

  const defaultPlugins = [
    ...undoHistory(),
    docHistory(),
    nativeMacWordNavigation,
    keymap({
      Tab: () => acceptSuggestion(),
      ArrowRight: () => acceptSuggestion(),
    }),
    baseKeymap,
    keymap({
      Enter: () => {
        // While an IME composition is in progress, Enter confirms the
        // composition — it must neither submit nor insert a newline.
        // (ProseMirror usually withholds keydown during composition, but this
        // also covers the Safari post-compositionend window.)
        if (get(imeIsComposing)) return true;
        if (submitSuggestion()) return true;
        submit();
        return true;
      },
      "Mod-Enter": () => {
        if (get(imeIsComposing)) return true;
        return submitNow();
      },
      "Ctrl-Space": (state, dispatch) => {
        dispatch?.(tryMatch(state.tr));
        return false;
      },
      ArrowUp: restorePreviousDoc,
      // History navigation first: a clean restored prompt ending in a code
      // block should step to the next entry, not grow an exit paragraph.
      ArrowDown: chainCommands(restoreNextDoc, exitTrailingCodeBlockBelow),
    }),
    selectionDecoration({
      filter: (node) => node.type === schema.nodes["chip"],
    }),
    matchDecoration({
      attrs: {
        class: "text-psx-foreground-secondary",
      },
      rules: () => get(rules),
    }),
    ...code(schema),
    clearStoredMarksPlugin,
    chipObserver,
  ];

  const editorState = EditorState.create({
    schema,
    plugins: plugins ?? defaultPlugins,
  });

  const closeMenuCommand: Command = (state, dispatch) => {
    if ($depth < 1) return false;

    if ($depth > 1 || !$editor?.hasFocus()) {
      pop();
    } else {
      dispatch?.(closeMatch(state.tr));
    }

    return true;
  };

  const interruptCommand: Command = () => interrupt();

  const escapeCommand = chainCommands(closeMenuCommand, interruptCommand);

  const focusCommand: Command = (_, __, view) => {
    const isEditableElement = (element: Element) => {
      return (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element?.hasAttribute("contenteditable")
      );
    };

    if (view?.hasFocus() || (document.activeElement && isEditableElement(document.activeElement))) {
      return false;
    }

    view?.focus();
    return true;
  };

  const keydown: KeyboardEventHandler<Window> = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Keystrokes inside a modal overlay (e.g. the conversation search) belong
    // to that overlay: Escape there must not interrupt the running turn.
    if (insideModalOverlay(e.target)) return;

    if (e.key === "Escape") {
      handlePromptEscape(e, () => $editor?.executeCommand(escapeCommand) ?? false);
      return;
    }

    // Don't focus the editor when disabled
    if ($disabled) return;

    if (/^[a-zA-Z0-9/@#]$/.test(e.key)) {
      return $editor?.executeCommand(focusCommand);
    }
  };

  const { customUI } = getDisplay();
</script>

<svelte:window onkeydown={keydown} />

<!-- min-w-0: without it this flex item's minimum size is the min-content
     width of the doc, so a long unbreakable token (a pasted URL) widens the
     editor past the field instead of wrapping — and the field's caret-reveal
     then scrolls the overflow, eating the composer's left padding. -->
<div class={["relative isolate min-w-0 grow leading-6", customUI ? "py-3" : "py-1"]}>
  <Editor
    bind:this={$editor}
    state={editorState}
    bind:isDefault
    bind:isComposing={$imeIsComposing}
    onUpdate={onEditorUpdate}
    editable={() => !$disabled}
    nodeViews={{
      chip: (node, view, getPos) => new ChipNodeView(node, view, getPos),
    }}
    attributes={{
      ...(id && { id }),
      "data-editor": "",
      "data-testid": "prompt-input",
      ...($disabled && { "data-disabled": "" }),
      // min-h-6 keeps an empty editor at one leading-6 line. The paragraph
      // rule below applies the same protection to every line in a multi-line
      // prompt.
      class: `${customUI ? "font-sans text-foreground-primary max-h-28" : "max-h-[50svh]"} min-h-6 ui-disabled:pointer-events-none ui-disabled:opacity-50 overflow-y-auto isolate focus:outline-hidden`,
      role: "combobox",
      "aria-disabled": `${$disabled}`,
      "aria-autocomplete": "list",
      "aria-expanded": `${!!$menu}`,
      "aria-controls": listId,
      "aria-labelledby": labelId,
    }}
  />

  {@render children?.()}
</div>

<style lang="postcss">
  @reference "#tailwind.css";
  :global(body.web-app [data-editor]) {
    @apply bg-(--text-mono-900);
    @media (pointer: coarse) {
      @apply text-[16px];
    }
  }

  /* ProseMirror replaces an empty paragraph's trailing <br> with the first
     typed character in separate DOM operations. Keep that paragraph's line
     box alive between operations so WebKit cannot briefly grow the chat
     viewport and clamp a bottom-pinned transcript upward. */
  :global([data-editor] > p) {
    @apply min-h-6;
  }

  :global([data-editor] pre) {
    @apply my-0.5 rounded-md bg-gray-100 px-2.5 py-2 font-mono text-xs dark:bg-gray-800;
    @apply border border-gray-200 dark:border-gray-700;
    @apply overflow-x-auto;
  }

  :global([data-editor] pre code) {
    @apply bg-transparent p-0 text-inherit;
  }

  /* Inline code (not inside pre blocks) */
  :global([data-editor] code:not(pre code)) {
    @apply relative isolate -z-10 inline whitespace-pre;
    @apply px-1 text-[92%] text-gray-800 dark:text-gray-200;
    @apply before:absolute before:inset-x-0 before:-inset-y-0.5 before:-z-10 before:w-full before:rounded-sm before:bg-gray-100 dark:before:bg-gray-700;
  }

  :global([data-editor].no-cursor) {
    caret-color: transparent;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  :global(.ProseMirror-focused .fake-cursor) {
    @apply relative isolate z-10 inline-block rounded-sm border-l border-psx-foreground-primary align-sub;
    /* Sized in em, not rem: the composer font is px-based, so the desktop
       root-font-size zoom would scale a rem cursor away from the text it
       sits in (a giant off-baseline bar at higher zoom levels). */
    height: 1.07em;
    margin-right: -0.055em;
    animation: blink 1s step-end infinite;

    @supports (-webkit-hyphens: none) {
      @apply border-l-2;
      height: 1em;
      margin-right: -0.135em;
    }
  }
</style>
