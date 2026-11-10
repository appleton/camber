import type { EntityCollection, EntityRelation } from "@camber/lib/types";
import { getContext, setContext } from "svelte";
import { writable } from "svelte/store";
import type { Destructor } from "../../../actions/floating.js";
import type { SectionProps } from "../list/Section.svelte";
import { type Item, type Section } from "./prompt.js";

const KEY = Symbol("list");

interface ListContext {
  registerSection: (id: Section["id"], section: SectionProps) => Destructor;
}

export type Sections = EntityCollection<Section>;
export type ItemsBySection = EntityRelation<Section, Item, "many">;

export function createList() {
  const sections = writable<Sections>(new Map());

  return setContext<ListContext>(KEY, {
    registerSection: (id, section) => {
      sections.update(($sections) =>
        $sections.set(id, {
          id,
          ...section,
        }),
      );

      return () => {
        sections.update(($sections) => {
          $sections.delete(id);
          return $sections;
        });
      };
    },
  });
}

export function getList() {
  return getContext<ListContext>(KEY);
}
