<script lang="ts" module>
  export interface InsertTextActionProps extends ActionBaseProps {
    type: "text";
    content: string;
    onInsert?: (content: InsertTextActionProps["content"]) => void;
  }

  export interface ChipContent {
    label: string;
    icon?: IconName;
    fileIconPath?: string;
    value: string;
    clipboard: string;
    tooltip?: string;
  }

  type CreateChipContent = SetOptional<ChipContent, "value" | "clipboard">;

  export interface ChipProps {
    content: ChipContent;
    onInsert?: (
      content: ChipContent,
      context: {
        undo: () => void;
      },
    ) => Promise<void> | void;
    onRemove?: (value: ChipContent["value"]) => void;
  }

  export interface CreateChipProps extends Pick<ChipProps, "onInsert" | "onRemove"> {
    content:
      | CreateChipContent
      | ((context: {
          triggerMatch: RegExpMatchArray;
          queryMatch?: RegExpMatchArray;
        }) => CreateChipContent | undefined);
  }

  export interface InsertChipActionProps extends ActionBaseProps, CreateChipProps {
    type: "chip";
  }
</script>

<script lang="ts">
  import { getChips, getMenus, getPrompt, type Chip } from "../context/prompt.js";
  import BaseAction, { type ActionBaseProps } from "./BaseAction.svelte";
  import { generateId } from "@camber/lib/string";
  import type { ChipNodeAttrs } from "../editor/chip/chipNode.js";
  import type { Snippet } from "svelte";
  import type { SetOptional } from "type-fest";
  import { getMatchDecorationState } from "../../editor/index.js";
  import type { IconName } from "../../icon/IconName.js";

  type Props = (InsertTextActionProps | InsertChipActionProps) & {
    children?: Snippet;
  };

  let { children, title, prominence, icon = "enter", ...props }: Props = $props();

  const { editor } = getPrompt();
  const { close } = getMenus();
  const { register } = getChips();

  function handleInsertText({ content, onInsert }: InsertTextActionProps) {
    if (!$editor) return;

    $editor.executeCommand((state, dispatch) => {
      dispatch?.(state.tr.insertText(content));
      close();
      onInsert?.(content);
      return true;
    });
  }

  function handleInsertChip(props: InsertChipActionProps) {
    if (!$editor) return;

    const { onInsert, onRemove } = props;

    $editor.executeCommand((state, dispatch) => {
      const { tr, schema } = state;
      const decoration = getMatchDecorationState(state);
      const hasMatch = decoration?.status === "match";

      let resolvedContent;
      if (typeof props.content === "function") {
        if (!hasMatch) return false;
        resolvedContent = props.content({
          triggerMatch: decoration.triggerMatch,
          queryMatch: decoration.queryMatch,
        });
      } else {
        resolvedContent = props.content;
      }

      if (!resolvedContent) return false;

      const { icon, fileIconPath, label, value, clipboard, tooltip } = resolvedContent;

      const id = generateId<Chip["id"]>();
      const content = {
        label,
        value: value ?? label,
        clipboard: clipboard ?? (hasMatch ? decoration.trigger : "") + label,
        icon,
        fileIconPath,
        tooltip,
      } satisfies Chip["content"];

      if (onRemove || onInsert) {
        register(id, { content, onRemove, onInsert });
      }

      const node = schema.nodes.chip.create({ id, ...content } satisfies ChipNodeAttrs);

      if (hasMatch) {
        dispatch?.(
          tr.replaceRangeWith(decoration.range.from, decoration.range.to, node).insertText(" "),
        );
      } else {
        const { from, to } = state.selection;
        dispatch?.(tr.replaceRangeWith(from, to, node).insertText(" "));
      }
      return true;
    });
  }

  function handleAction() {
    switch (props.type) {
      case "chip":
        handleInsertChip(props);
        break;
      case "text":
      default:
        handleInsertText(props);
        break;
    }
  }
</script>

<BaseAction type="insert" {title} {icon} {prominence} onAction={handleAction}>
  {@render children?.()}
</BaseAction>
