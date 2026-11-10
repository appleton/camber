import { generateId } from "@camber/lib/string";
import { getContext, onMount, setContext } from "svelte";
import type { SectionProps } from "../list/Section.svelte";
import { getList } from "./list.js";
import type { Section } from "./prompt.js";

const KEY = Symbol("section");

export function createSection(props: SectionProps) {
  const { registerSection } = getList();

  const id = generateId<Section["id"]>();

  onMount(() => {
    const unregister = registerSection(id, props);
    return unregister;
  });

  return setContext<Section>(KEY, { id, ...props });
}

export function getSection() {
  return getContext<Section>(KEY);
}
