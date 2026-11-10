import { generateId } from "@camber/lib/string";
import { getContext, onMount, setContext } from "svelte";
import { derived, writable, type Readable } from "svelte/store";
import type { ItemProps } from "../list/Item.svelte";
import { getActions, getItems, type Action, type Item } from "./prompt.js";
import { getSection } from "./section.js";

const KEY = Symbol("item");

interface ItemContext extends Item {
  action: Readable<Action | undefined>;
  isSelected: Readable<boolean>;
  select: () => void;
  elements: {
    rootEl: Readable<HTMLElement | undefined>;
    leadingEl: Readable<HTMLElement | undefined>;
    subtitleEl: Readable<HTMLElement | undefined>;
    accessoriesEl: Readable<HTMLElement | undefined>;
  };
}

export function createItem(item: ItemProps) {
  const id = generateId<Item["id"]>();

  const { selected, register, select } = getItems();
  const { actions, actionByItem } = getActions();

  const section = getSection();

  onMount(() => {
    const unregister = register(id, item, section.id);
    return unregister;
  });

  return setContext<ItemContext>(KEY, {
    ...item,
    id,
    sectionId: section.id,
    isSelected: derived(selected, ($selected) => $selected === id),
    action: derived([actions, actionByItem], ([$actions, $actionByItem]) => {
      const actionId = $actionByItem.get(id);
      if (!actionId) return;
      return $actions.get(actionId);
    }),
    elements: {
      rootEl: writable(),
      leadingEl: writable(),
      subtitleEl: writable(),
      accessoriesEl: writable(),
    },
    select: () => select(id),
  });
}

export function getItem() {
  return getContext<ItemContext>(KEY);
}
