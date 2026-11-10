import type { Command } from "@camber/components/editor";
import { getChips, type ChipNodeAttrs } from "@camber/components/prompt";
import { basename } from "@camber/lib/path";
import { generateId } from "@camber/lib/string";
import {
  DESKTOP_FILE_PROMPT_CHIP_EVENT,
  type DesktopFilePromptChipEventDetail,
} from "./desktopFilePromptChip";

type PromptChips = ReturnType<typeof getChips>;
type PromptChipRegistration = Parameters<PromptChips["register"]>[1];
type PromptChipContent = PromptChipRegistration["content"];

export interface DesktopFilePromptChipEditor {
  executeCommand(command: Command): void;
  focus(): void;
}

export interface DesktopFilePromptChipRegistry {
  register: PromptChips["register"];
}

export interface DesktopFilePromptChipInsertOptions {
  editor: DesktopFilePromptChipEditor | undefined;
  chips: DesktopFilePromptChipRegistry;
  onInsertFile: (path: string) => Promise<void> | void;
  onRemoveFile: (path: string) => void;
  idFactory?: () => Parameters<PromptChips["register"]>[0];
}

export interface DesktopFilePromptChipEventOptions extends DesktopFilePromptChipInsertOptions {
  enabled?: boolean;
}

export function desktopFilePromptChipContent(path: string): PromptChipContent {
  const label = basename(path) || path;

  return {
    label,
    value: path,
    clipboard: `\`${path}\``,
    icon: "file",
    fileIconPath: path,
    tooltip: path,
  } satisfies PromptChipContent;
}

export function insertDesktopFilePromptChip(
  path: string,
  { editor, chips, onInsertFile, onRemoveFile, idFactory }: DesktopFilePromptChipInsertOptions,
): boolean {
  if (!editor) return false;

  const id = idFactory?.() ?? generateId<Parameters<PromptChips["register"]>[0]>();
  const content = desktopFilePromptChipContent(path);

  chips.register(id, {
    content,
    onInsert: async ({ value }) => {
      await onInsertFile(value);
    },
    onRemove: (value) => {
      onRemoveFile(value);
    },
  } satisfies PromptChipRegistration);

  editor.executeCommand((state, dispatch) => {
    const node = state.schema.nodes.chip.create({ id, ...content } satisfies ChipNodeAttrs);
    const { from, to } = state.selection;
    dispatch?.(state.tr.replaceRangeWith(from, to, node).insertText(" "));
    return true;
  });
  editor.focus();
  return true;
}

export function handleDesktopFilePromptChipEvent(
  event: Event,
  { enabled = true, ...options }: DesktopFilePromptChipEventOptions,
): boolean {
  if (!enabled || event.defaultPrevented) return false;
  if (event.type !== DESKTOP_FILE_PROMPT_CHIP_EVENT) return false;

  const path = (event as CustomEvent<DesktopFilePromptChipEventDetail>).detail?.path;
  if (!path) return false;
  if (!insertDesktopFilePromptChip(path, options)) return false;

  event.preventDefault();
  return true;
}
