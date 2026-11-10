import { generateId } from "@camber/lib/string";
import { getContext, onMount, setContext } from "svelte";
import { type CreateMenuProps, getMenus, type Menu } from "./prompt.js";

const KEY = Symbol("menu");

export function createMenu(props: CreateMenuProps) {
  const { register } = getMenus();

  const id = generateId<Menu["id"]>();

  onMount(() => {
    const unregister = register(id, props);
    return unregister;
  });

  return setContext<Menu>(KEY, { id, ...props });
}

export function getMenu() {
  return getContext<Menu>(KEY);
}
