import { getOrSet } from "@camber/lib/map";
import fuzzysort from "fuzzysort";
import type { ItemsBySection } from "../context/list.js";
import type { Item } from "../context/prompt.js";

export interface FilterOptions {
  /**
   * When true, if any item has a title match, only items with title matches will be shown.
   *
   * @default false
   */
  strictTitleMatching?: boolean;

  /**
   * The minimum score that can be returned
   */
  threshold?: number;
}

interface SearchItem extends Pick<Item, "title" | "subtitle"> {
  score: number;
}

export interface FilterResult {
  items: Map<Item["id"], SearchItem>;
  sections: ItemsBySection;
}

export function filter(search: string, items: ReadonlyArray<Item>, options: FilterOptions = {}) {
  const { strictTitleMatching } = options;
  const results = fuzzysort.go(search, items, {
    all: true,
    keys: [
      ({ title }) => (typeof title === "string" ? title : title.value),
      ({ subtitle }) => (typeof subtitle === "string" ? subtitle : subtitle?.value) ?? "",
      ({ keywords }) => keywords?.join(" ") ?? "",
    ],
    threshold: options.threshold,
    scoreFn: (result) => {
      const { obj, score } = result;
      const resolvedTitle = typeof obj.title === "string" ? obj.title : obj.title.value;
      return score * (resolvedTitle.startsWith(search) ? 2 : 1);
    },
    limit: 50,
  });

  const filteredItems: FilterResult["items"] = new Map();
  const filteredSections: FilterResult["sections"] = new Map();

  const someTitleMatches = results.some(([titleMatch]) => titleMatch?.score);

  for (const result of results) {
    const {
      obj: { id, sectionId, title, subtitle },
      score,
    } = result;
    const [titleMatch, subtitleMatch] = result;

    if (strictTitleMatching && !titleMatch?.score && someTitleMatches) continue;

    filteredItems.set(id, {
      score,
      title: {
        value: typeof title === "string" ? title : title.value,
        score: titleMatch.score,
        indices: titleMatch.indexes,
      },
      subtitle: subtitle
        ? {
            value: typeof subtitle === "string" ? subtitle : subtitle.value,
            score: subtitleMatch.score,
            indices: subtitleMatch.indexes,
          }
        : undefined,
    });

    getOrSet(filteredSections, sectionId, new Set<Item["id"]>()).add(id);
  }

  return {
    items: filteredItems,
    sections: filteredSections,
  };
}
