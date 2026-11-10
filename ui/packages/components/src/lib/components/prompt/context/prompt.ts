import { getOrSet } from "@camber/lib/map";
import { generateId } from "@camber/lib/string";
import type { BaseEntity, EntityCollection, EntityRelation } from "@camber/lib/types";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { getContext, onMount, setContext, tick } from "svelte";
import { derived, get, writable, type Readable, type Writable } from "svelte/store";
import type { SetRequired } from "type-fest";
import type { Destructor } from "../../../actions/floating.js";
import { createNavigationStore } from "../../../stores/navigation.js";
import type { Editor } from "../../editor/index.js";
import {
  deleteAll,
  getMatchDecorationState,
  saveDocMeta,
  type MatchDecorationRule,
} from "../../editor/index.js";
import type { ActionProps } from "../actions/BaseAction.svelte";
import type { ChipProps } from "../actions/InsertAction.svelte";
import { markdownParser, markdownSerializer, schema } from "../editor/schema.js";
import type { ItemProps } from "../list/Item.svelte";
import type { SectionProps } from "../list/Section.svelte";
import type { MenuProps, MenuRule } from "../menu/Menu.svelte";
import type { PromptProps } from "../Prompt.svelte";
import { filter, type FilterResult } from "../utils/filter.js";

const PROMPT_KEY = Symbol("prompt");
const MENUS_KEY = Symbol("menus");
const ITEMS_KEY = Symbol("items");
const ACTIONS_KEY = Symbol("actions");
const CHIPS_KEY = Symbol("chips");

export type CreateMenuProps = SetRequired<MenuProps, "highlightMatch" | "loop" | "shouldFilter">;

export interface Menu extends BaseEntity<"menu">, CreateMenuProps {}

export interface Section extends BaseEntity<"section">, SectionProps {}

export interface Item extends BaseEntity<"item">, ItemProps {
  sectionId: Section["id"];
}

export interface Action extends BaseEntity<"action">, ActionProps {
  itemId: Item["id"];
}
export interface Chip extends BaseEntity<"chip">, ChipProps {}

type Menus = EntityCollection<Menu>;
type Items = EntityCollection<Item>;
export type Actions = EntityCollection<Action>;
export type Chips = EntityCollection<Chip>;

export type ItemsBySection = EntityRelation<Section, Item, "many">;
export type ActionsByItem = EntityRelation<Item, Action, "many">;
export type ActionByItem = EntityRelation<Item, Action>;

/**
 * Lookups for quick access
 */
type MenusByValue = Map<Required<Menu["value"]>, Menu["id"]>;
type ChipsByValue = Map<Required<Chip["content"]["value"]>, Chip["id"]>;

export interface PromptContext {
  /**
   * Tracks whether an Input Method Editor (IME) composition is in progress.
   * Used for languages like Chinese, Japanese, or Korean that require multi-stage text input.
   */
  imeIsComposing: Writable<boolean>;

  /**
   * Indicates whether the prompt content has been modified from its original state.
   */
  isDirty: Writable<boolean>;

  /**
   * Indicates whether a submission is in progress.
   * Used to prevent chip onRemove callbacks from firing during submit.
   */
  isSubmitting: Readable<boolean>;

  /**
   * Indicates whether the prompt is disabled (read-only).
   * When true, the editor should not accept user input.
   */
  disabled: Readable<boolean>;

  /**
   * Determines if the prompt can be submitted in its current state.
   */
  canSubmit: Readable<boolean>;

  /**
   * Ephemeral text the user may accept into an otherwise empty editor.
   */
  suggestion: Readable<string | null | undefined>;

  /**
   * Accepts the current suggestion into the editor without submitting it.
   */
  acceptSuggestion: () => boolean;

  /**
   * Submits the current suggestion without first inserting it into the editor.
   */
  submitSuggestion: () => boolean;

  /**
   * Clears the prompt editor.
   */
  clear: () => void;

  /**
   * Replaces the editor content with the given text (parsed as markdown) and focuses the editor.
   */
  restore: (text: string) => void;

  /**
   * Replaces the editor content without focusing by default.
   */
  setValue: (text: string, options?: { focus?: boolean }) => void;

  /**
   * Focuses the prompt editor.
   * @returns false when the editor is not mounted yet
   */
  focus: () => boolean;

  /**
   * Records editor content changes.
   */
  onEditorUpdate: (state: EditorState) => void;

  /**
   * Resets the prompt to its initial state.
   */
  reset: () => void;

  /**
   * Interrupts the current operation.
   * @returns true when an interrupt handler was available
   */
  interrupt: () => boolean;

  /**
   * Submits the current prompt content for processing.
   * @returns true if submission started
   */
  submit: (text?: string) => boolean;

  /**
   * Submits through the optional alternate submit action.
   * @returns true if alternate submission started
   */
  submitNow: (text?: string) => boolean;

  /**
   * Reference to the editor instance used by the prompt.
   */
  editor: Writable<Editor | undefined>;

  elements: {
    rootId: string;
    labelId: string;
    listId: string;
    rootEl: Writable<HTMLElement | undefined>;
    contentEl: Writable<HTMLElement | undefined>;
    listEl: Writable<HTMLElement | undefined>;
    submitEl: Writable<HTMLElement | undefined>;
    inputEl: Writable<HTMLElement | undefined>;
  };
  menus: MenusContext;
}

export interface MenusContext {
  rules: Readable<MatchDecorationRule[]>;
  search: Writable<string | undefined>;
  home: Readable<Menu["id"] | undefined>;
  menu: Readable<Menu | undefined>;
  depth: Readable<number>;

  register: (id: Menu["id"], menu: CreateMenuProps) => Destructor;
  get: (value: Menu["value"]) => Menu | undefined;
  has: (id: Menu["id"]) => boolean;
  open: (id: Menu["id"]) => void;
  push: (value: Menu["value"], baseQuery?: string) => void;
  pop: () => void;
  close: () => void;
}

export interface ItemsContext {
  items: Readable<Items>;
  itemsBySection: Readable<ItemsBySection>;
  filtered: Readable<FilterResult | undefined>;
  selected: Readable<Item["id"] | undefined>;
  selectedAction: Readable<Action | undefined>;
  register: (id: Item["id"], item: ItemProps, sectionId: Section["id"]) => Destructor;
  updateDisabled: (id: Item["id"], disabled: boolean | undefined) => void;
  getFirstInteractiveItemElement: () => HTMLElement | undefined;
  getInteractiveItemElements: () => HTMLElement[];
  select: (target: Item["id"] | HTMLElement, scrollIntoView?: boolean) => void;
  selectNext: (scrollIntoView?: boolean) => void;
  selectPrevious: (scrollIntoView?: boolean) => void;
  selectFirst: (scrollIntoView?: boolean) => void;
  selectLast: (scrollIntoView?: boolean) => void;
}

export interface ActionsContext {
  actions: Readable<Actions>;
  actionByItem: Readable<ActionByItem>;
  register: (id: Action["id"], action: ActionProps, itemId: Item["id"]) => Destructor;
}

export interface ChipsContext {
  register: (id: Chip["id"], chip: ChipProps) => Destructor;
  get: (id: Chip["id"]) => Chip | undefined;
  getByValue: (value: Chip["content"]["value"]) => Chip | undefined;
}

export interface PromptOptions
  extends Omit<PromptProps, "onInterrupt" | "suggestion" | "onSuggestionAccepted"> {
  submitDisabled: Readable<boolean | undefined>;
  disabled: Readable<boolean>;
  onInterrupt: Readable<PromptProps["onInterrupt"]>;
  suggestion: Readable<PromptProps["suggestion"]>;
  onSuggestionAccepted: Readable<PromptProps["onSuggestionAccepted"]>;
}

export function createPrompt({
  value = "",
  submitDisabled,
  disabled,
  onSubmit,
  onSubmitNow,
  onInterrupt,
  onValueChange,
  suggestion,
  onSuggestionAccepted,
}: PromptOptions) {
  const search = writable<string | undefined>();
  const selectedItem = writable<Item["id"] | undefined>();

  const elements = {
    rootId: generateId(),
    listId: generateId(),
    labelId: generateId(),
    rootEl: writable(),
    contentEl: writable(),
    listEl: writable(),
    inputEl: writable(),
    submitEl: writable(),
  } satisfies PromptContext["elements"];

  const resetMenuState = () => {
    search.set(undefined);
    selectedItem.set(undefined);
  };

  const onNavigate = () => {
    resetMenuState();

    const $editor = get(prompt.editor);
    const $menu = get(menu);
    if (!$editor || !$menu) return;

    $menu.rules?.forEach(({ trigger, behavior }) => {
      if (trigger) {
        $editor.executeCommand(insertTrigger(trigger, behavior));
        return;
      }
    });
  };

  const navigation = createNavigationStore<Menu["id"]>([], {
    onNavigate,
    onReplace: resetMenuState,
    onClear: resetMenuState,
  });

  const menus = writable<Menus>(new Map());
  const menusByValue = writable<MenusByValue>(new Map());
  const items = writable<Items>(new Map());
  const actions = writable<Actions>(new Map());
  const chips = writable<Chips>(new Map());
  const chipsByValue = writable<ChipsByValue>(new Map());

  const itemsBySection = derived(items, ($items) => {
    const out: ItemsBySection = new Map();
    for (const [id, item] of $items) {
      if (!item.sectionId) continue;
      getOrSet(out, item.sectionId, new Set<Item["id"]>()).add(id);
    }
    return out;
  });

  const actionsByItem = derived(actions, ($actions) => {
    const out: ActionsByItem = new Map();
    for (const [id, action] of $actions) {
      getOrSet(out, action.itemId, new Set<Action["id"]>()).add(id);
    }
    return out;
  });

  function deferredStoreUpdate<T>(store: Writable<T>): () => void {
    let updating = false;
    return async () => {
      if (updating) return; // already in the process of updating
      updating = true;
      await Promise.resolve();
      updating = false;
      store.set(get(store));
    };
  }

  const notifyItemsUpdate = deferredStoreUpdate(items);
  const notifyActionsUpdate = deferredStoreUpdate(actions);

  const { onMount: altKeyOnMount, isAltKeyPressed } = createAltKeyStore();

  onMount(altKeyOnMount);

  const actionByItem = derived(
    [actionsByItem, isAltKeyPressed],
    ([$actionsByItem, $isAltKeyPressed]) => {
      const results: ActionByItem = new Map();

      let actionId: Action["id"] | undefined;
      for (const [item, actions] of $actionsByItem) {
        if (actions.size > 1 && $isAltKeyPressed) {
          const [, secondary] = actions.values();
          actionId = secondary;
        } else {
          const [primary] = actions.values();
          actionId = primary;
        }

        results.set(item, actionId);
      }

      return results;
    },
  );

  const getMenu: MenusContext["get"] = (value) => {
    const $menusByValue = get(menusByValue);
    const id = $menusByValue.get(value);
    if (!id) return;
    return get(menus).get(id);
  };

  const hasMenu: MenusContext["has"] = (id) => {
    const exists = get(menus).has(id);
    if (!exists) console.warn(`Menu "${id}" does not exist`);
    return exists;
  };

  const menu = derived([navigation.current, menus], ([$current, $menus]) =>
    $current ? $menus.get($current) : undefined,
  );

  /**
   * The latest query matched by an editor trigger rule (e.g. "model" for
   * "/model"). Captured when pushing a submenu so continued typing can be
   * resolved relative to it instead of re-opening the trigger's menu.
   */
  let lastMatchQuery: string | undefined;
  const pushedBaseQueries: string[] = [];

  const menusContext: MenusContext = setContext<MenusContext>(MENUS_KEY, {
    menu,
    rules: derived(menus, ($menus) => {
      const menusToCheck: Menu[] = [];
      const $menu = get(menu);

      // first check the current menu
      if ($menu) menusToCheck.push($menu);

      // then all other menus
      for (const [id, menu] of $menus) {
        if (id !== $menu?.id) {
          menusToCheck.push(menu);
        }
      }

      const rules: MatchDecorationRule[] = [];
      menusToCheck.forEach((menu) => {
        menu.rules?.forEach(({ triggerRegExp, queryRegExp, attrs }) => {
          rules.push({
            triggerRegExp,
            queryRegExp,
            attrs,
            shouldMatch: ({ query }) => {
              // A pushed submenu deliberately keeps matching after its
              // completion space. Whitespace ends every other menu match
              // inside the plugin state transition, before callbacks run.
              const base = pushedBaseQueries.at(-1);
              return !/\s/.test(query) || (base !== undefined && query.startsWith(base));
            },
            onMatch: (params) => {
              lastMatchQuery = params.query;

              // While a pushed submenu is open (e.g. the model list pushed
              // from "/model"), typing extends the original trigger match.
              // Filter the submenu with the extra text instead of letting the
              // trigger's menu steal the navigation (and show "no matches").
              const base = pushedBaseQueries.at(-1);
              if (base !== undefined && params.query.startsWith(base)) {
                search.set(params.query.slice(base.length));
                return;
              }

              open(menu.id);
              search.set(params.query);
            },
            onEnd: () => {
              lastMatchQuery = undefined;
              close();
            },
          });
        });
      });

      return rules;
    }),
    depth: navigation.depth,
    close: () => {
      pushedBaseQueries.length = 0;
      navigation.clear();
    },
    pop: () => {
      pushedBaseQueries.pop();
      navigation.pop();
    },
    open: (id) => {
      if (hasMenu(id) && id !== get(menu)?.id) {
        pushedBaseQueries.length = 0;
        navigation.replace(id);
      }
    },
    push: (value, baseQuery) => {
      const target = getMenu(value);
      if (!target) return;
      pushedBaseQueries.push(baseQuery ?? lastMatchQuery ?? "");
      navigation.push(target.id);
    },
    search,
    home: derived(menus, ($menus) => $menus.keys().next().value),
    register: (id, { value, ...menu }) => {
      menus.update(($menus) => $menus.set(id, { id, value, ...menu }));
      if (value) {
        menusByValue.update(($menus) => $menus.set(value, id));
      }

      return () => {
        menus.update(($menus) => {
          $menus.delete(id);
          return $menus;
        });

        if (value) {
          menusByValue.update(($menus) => {
            $menus.delete(value);
            return $menus;
          });
        }
      };
    },
    get: getMenu,
    has: hasMenu,
  });

  const { open, close } = menusContext;

  const { select, getInteractiveItemElements } = setContext<ItemsContext>(ITEMS_KEY, {
    items,
    itemsBySection,
    selected: selectedItem,
    selectedAction: derived(
      [selectedItem, actionByItem, actions, items],
      ([$selectedItem, $actionByItem, $actions, $items]) => {
        if (!$selectedItem) return;
        const item = $items.get($selectedItem);
        if (item?.disabled) return;
        const id = $actionByItem.get($selectedItem);
        if (!id) return;
        return $actions.get(id);
      },
    ),
    filtered: derived([search, items, menu], ([$search, $items, $menu], set) => {
      tick().then(() => {
        if (!$search || !$menu?.shouldFilter) {
          set(undefined);
          return;
        }

        const targets = Array.from($items.values());
        const filtered = filter($search, targets, $menu.filterOptions);

        set(filtered);
      });
    }),
    updateDisabled: (id, disabled) => {
      items.update(($items) => {
        const item = $items.get(id);
        if (item) $items.set(id, { ...item, disabled });
        return $items;
      });
    },

    register: (id, item, sectionId) => {
      const $items = get(items);
      $items.set(id, { id, sectionId, ...item });
      notifyItemsUpdate();

      return () => {
        const $items = get(items);
        $items.delete(id);
        notifyItemsUpdate();
      };
    },

    getFirstInteractiveItemElement: (container?: HTMLElement) => {
      const element = container ?? get(elements.listEl);
      if (!element) return;

      return (
        element.querySelector<HTMLElement>('[data-prompt-item]:not([aria-disabled="true"]') ??
        undefined
      );
    },

    getInteractiveItemElements: (container?: HTMLElement) => {
      const element = container ?? get(elements.listEl);
      if (!element) return [];

      // While filtering, items are ranked visually with a score-based flex
      // `order`, so DOM order no longer matches what the user sees — navigate
      // and select in visual order.
      return Array.from(
        element.querySelectorAll<HTMLElement>('[data-prompt-item]:not([aria-disabled="true"]'),
      ).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    },

    select: (target, scrollIntoView = true) => {
      const id = target instanceof HTMLElement ? (target.id as Item["id"]) : target;

      if (id !== get(selectedItem)) {
        selectedItem.set(id);

        if (scrollIntoView) {
          const element = target instanceof HTMLElement ? target : document.getElementById(target);
          if (!element) return;

          element.scrollIntoView({ block: "nearest" });
        }
      }
    },

    selectNext: (scrollIntoView) => {
      const $menu = get(menu);

      if (!$menu) return;

      const $selectedItem = get(selectedItem);

      const elements = getInteractiveItemElements();
      const currentIndex = elements.findIndex((item) => item.id === $selectedItem);

      let nextIndex = currentIndex + 1;

      if ($menu.loop) {
        if (nextIndex < 0) {
          nextIndex = elements.length - 1;
        } else if (nextIndex === elements.length) {
          nextIndex = 0;
        }
      }

      select(elements[nextIndex], scrollIntoView);
    },

    selectPrevious: (scrollIntoView) => {
      const $menu = get(menu);
      if (!$menu) return;

      const $selectedItem = get(selectedItem);

      const elements = getInteractiveItemElements();
      const currentIndex = elements.findIndex((item) => item.id === $selectedItem);

      let prevIndex = currentIndex - 1;

      if ($menu.loop) {
        if (prevIndex < 0) {
          prevIndex = elements.length - 1;
        } else if (prevIndex >= elements.length) {
          prevIndex = 0;
        }
      }

      select(elements[prevIndex], scrollIntoView);
    },

    selectFirst: (scrollIntoView) => {
      const elements = getInteractiveItemElements();
      if (!elements.length) return;
      select(elements[0], scrollIntoView);
    },

    selectLast: (scrollIntoView) => {
      const elements = getInteractiveItemElements();
      if (!elements.length) return;
      select(elements[elements.length - 1], scrollIntoView);
    },
  });

  setContext<ActionsContext>(ACTIONS_KEY, {
    actions,
    actionByItem,
    register: (id, action, itemId) => {
      const $actions = get(actions);
      $actions.set(id, { id, itemId, ...action });
      notifyActionsUpdate();

      return () => {
        const $actions = get(actions);
        $actions.delete(id);
        notifyActionsUpdate();
      };
    },
  });

  setContext<ChipsContext>(CHIPS_KEY, {
    register: (id, { content, onInsert, onRemove }) => {
      chips.update(($chips) =>
        $chips.set(id, {
          id,
          content,
          onInsert,
          onRemove,
        }),
      );

      chipsByValue.update(($chipsByValue) => $chipsByValue.set(content.value, id));

      return () => {
        chips.update(($chips) => {
          $chips.delete(id);
          return $chips;
        });
        chipsByValue.update(($chipsByValue) => {
          $chipsByValue.delete(content.value);
          return $chipsByValue;
        });
      };
    },
    get: (id) => get(chips).get(id),
    getByValue: (value) => {
      const $chipsByValue = get(chipsByValue);
      const id = $chipsByValue.get(value);
      if (!id) return;
      return get(chips).get(id);
    },
  });

  const imeIsComposing = writable(false);
  const isDirty = writable(false);
  const isSubmitting = writable(false);
  let currentValue = value;
  let suppressValueChange = false;

  function parsePrompt(text: string) {
    try {
      return markdownParser.parse(text);
    } catch {
      return schema.node("doc", null, [
        schema.node("paragraph", null, text ? [schema.text(text)] : []),
      ]);
    }
  }

  function setValue(text: string, { focus = false }: { focus?: boolean } = {}) {
    currentValue = text;
    const $editor = get(prompt.editor);
    if (!$editor) return;
    const doc = parsePrompt(text);
    suppressValueChange = true;
    $editor.executeCommand((state, dispatch) => {
      const { tr } = state;
      tr.replaceWith(0, state.doc.content.size, doc.content);
      dispatch?.(tr);
      return true;
    });
    suppressValueChange = false;
    if (focus) {
      $editor.focus();
    }
  }

  function onEditorUpdate(state: EditorState) {
    if (suppressValueChange) return;
    const nextValue = markdownSerializer.serialize(state.doc);
    if (nextValue === currentValue) return;
    currentValue = nextValue;
    onValueChange?.(nextValue);
  }

  function availableSuggestion(): { editor: Editor; text: string } | undefined {
    const text = get(suggestion);
    const $editor = get(prompt.editor);
    if (!text || !$editor || get(disabled) || get(imeIsComposing) || get(isDirty) || get(menu)) {
      return;
    }

    return { editor: $editor, text };
  }

  function acceptSuggestion(): boolean {
    const available = availableSuggestion();
    if (!available) return false;
    const { editor: $editor, text } = available;

    const doc = parsePrompt(text);
    let accepted = false;
    $editor.executeCommand((state, dispatch) => {
      if (state.doc.textContent.length > 0) return false;
      const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
      tr.setSelection(TextSelection.atEnd(tr.doc));
      dispatch?.(tr);
      accepted = true;
      return true;
    });
    if (!accepted) return false;

    $editor.focus();
    get(onSuggestionAccepted)?.(text);
    return true;
  }

  // Deliberately ignores imeIsComposing: an in-progress IME composition must
  // only block the *Enter* submit path (where Enter means "confirm the
  // composition") — see the prompt editor's keymap. Clicking the send button
  // inherently commits or cancels a pending composition, so disabling it here
  // would only leave the button stuck when the composing flag goes stale
  // (e.g. macOS predictive text at the end of the prompt, PE-2456).
  const canSubmit = derived(
    [isDirty, menu, submitDisabled],
    ([$isDirty, $menu, $submitDisabled]) => {
      return $isDirty && !$menu && !$submitDisabled;
    },
  );

  function submitTo(
    callback: ((text: string) => void) | undefined,
    text?: string,
    allowClean = false,
  ): boolean {
    const $editor = get(prompt.editor);
    if (!$editor || (!allowClean && !get(canSubmit))) return false;
    isSubmitting.set(true);

    let submitted = false;
    $editor.executeCommand(((state, dispatch) => {
      const { tr, doc } = state;
      if (allowClean && doc.textContent.length > 0) return false;
      text ??= markdownSerializer.serialize(doc);
      callback?.(text);

      tr.delete(0, doc.content.size);
      dispatch?.(saveDocMeta(tr));
      submitted = true;
      return false;
    }) satisfies Command);

    isSubmitting.set(false);
    if (!submitted) return false;
    close();
    return true;
  }

  function submitSuggestion(): boolean {
    const available = availableSuggestion();
    if (!available || get(submitDisabled)) return false;

    const { text } = available;
    const submitted = submitTo(onSubmit, text, true);
    if (submitted) get(onSuggestionAccepted)?.(text);
    return submitted;
  }

  const prompt = setContext<PromptContext>(PROMPT_KEY, {
    editor: writable(),
    elements,
    imeIsComposing,
    isDirty,
    isSubmitting,
    disabled,
    canSubmit,
    suggestion,
    acceptSuggestion,
    submitSuggestion,
    menus: menusContext,
    clear: () => {
      const $editor = get(prompt.editor);
      if (!$editor) return;
      $editor.executeCommand(deleteAll);
    },
    restore: (text: string) => setValue(text, { focus: true }),
    setValue,
    focus: () => {
      const $editor = get(prompt.editor);
      if (!$editor) return false;
      $editor.focus();
      return true;
    },
    onEditorUpdate,
    reset: () => {
      prompt.clear();

      chips.update(($chips) => {
        $chips.forEach((chip) => chip.onRemove?.(chip.content.value));
        $chips.clear();
        return $chips;
      });

      chipsByValue.update(($chipsByValue) => {
        $chipsByValue.clear();
        return $chipsByValue;
      });
    },
    interrupt: () => {
      const handler = get(onInterrupt);
      if (!handler) return false;
      handler();
      return true;
    },
    submit: (text) => submitTo(onSubmit, text),
    submitNow: (text) => (onSubmitNow ? submitTo(onSubmitNow, text) : false),
  });

  onMount(() =>
    prompt.editor.subscribe(($editor) => {
      if (!$editor) return;
      setValue(currentValue, { focus: false });
    }),
  );

  return prompt;
}

export function getPrompt() {
  return getContext<PromptContext>(PROMPT_KEY);
}

export function getMenus() {
  return getContext<MenusContext>(MENUS_KEY);
}

export function getItems() {
  return getContext<ItemsContext>(ITEMS_KEY);
}

export function getActions() {
  return getContext<ActionsContext>(ACTIONS_KEY);
}

export function getChips() {
  return getContext<ChipsContext>(CHIPS_KEY);
}

/**
 * TODO: refactor into keyboard store with register shortcut features
 */
function createAltKeyStore() {
  const isAltKeyPressed = writable(false);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Alt") isAltKeyPressed.set(true);
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Alt") isAltKeyPressed.set(false);
  };

  const handleBlur = () => {
    isAltKeyPressed.set(false);
  };

  const onMount = () => {
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  };

  return { isAltKeyPressed, onMount };
}

function insertTrigger(trigger: string, behavior: MenuRule["behavior"]): Command {
  return (state, dispatch, view) => {
    const decoration = getMatchDecorationState(state);
    const { tr } = state;

    if (behavior === "always" || (behavior === "when-focused" && view?.hasFocus())) {
      if (decoration?.status === "match") {
        tr.insertText(trigger, decoration.range.from, decoration.range.to);
      } else {
        tr.insertText(trigger);
      }

      dispatch?.(tr);

      if (behavior === "always") {
        view?.focus();
      }
    }

    return true;
  };
}
