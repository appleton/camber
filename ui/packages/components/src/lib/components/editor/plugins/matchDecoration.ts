import { cx } from "@camber/tailwind-config/tv";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Selection,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet, type DecorationAttrs } from "prosemirror-view";

type Range = { from: number; to: number };

interface MatchResult {
  trigger: string;
  triggerMatch: RegExpMatchArray;
  query: string;
  queryMatch?: RegExpMatchArray;
  range: Range;
}

type IdleStatus = {
  status: "idle";
};

interface MatchStatus extends MatchResult {
  status: "match";
  rule: MatchDecorationRule;
  ruleIndex: number;
  decorations: DecorationSet;
}

type MatchState = IdleStatus | MatchStatus;

interface MatchParams extends MatchResult {}

type MatchCallbacks = {
  onStart?: (params: MatchParams) => void;
  onMatch?: (params: MatchParams) => void;
  onChange?: (params: MatchParams) => void;
  onEnd?: (params: MatchParams) => void;
};

export interface MatchDecorationRule extends MatchCallbacks {
  /**
   * A regular expression pattern that identifies when to activate the decoration.
   * @example /(?<=\s|^)@(?!\s)/g
   */
  triggerRegExp: RegExp;

  /**
   * A regular expression pattern for the query part after the trigger.
   * @default /^.*$/
   */
  queryRegExp?: RegExp;

  /**
   * An optional predicate applied after the trigger and query regular
   * expressions match. Returning false keeps the decoration idle.
   */
  shouldMatch?: (params: MatchParams) => boolean;

  attrs?: DecorationAttrs;
}

export interface MatchOptions extends MatchCallbacks {
  attrs?: DecorationAttrs;
  rules: MatchDecorationRule[] | (() => MatchDecorationRule[]);
}

const MATCH_DECORATION_KEY = new PluginKey<MatchState>("match");
const DEFAULT_QUERY_REG_EXP = /^.*$/;
const DEFAULT_ATTRS: DecorationAttrs = {
  nodeName: "span",
  class: "match",
};

export function getMatchDecorationState(state: EditorState) {
  return MATCH_DECORATION_KEY.getState(state);
}

function shouldSkipDecoration(tr: Transaction) {
  const { doc, selection } = tr;
  const { marks, nodes } = doc.type.schema;

  if (marks["code"]?.isInSet(selection.$from.marks())) return true;
  const { $from } = selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (node.type === nodes["code_block"]) return true;
  }

  return false;
}

export function matchDecoration({
  attrs: baseAttrs,
  rules,
  onStart,
  onChange,
  onMatch,
  onEnd,
}: MatchOptions) {
  function createDecoration(from: number, to: number, attrs?: DecorationAttrs) {
    return Decoration.inline(
      from,
      to,
      {
        ...DEFAULT_ATTRS,
        ...baseAttrs,
        ...attrs,
        class: cx(baseAttrs?.class, attrs?.class) || DEFAULT_ATTRS.class,
      },
      {
        inclusiveStart: false,
        inclusiveEnd: true,
      },
    );
  }

  return new Plugin<MatchState>({
    key: MATCH_DECORATION_KEY,
    state: {
      init() {
        return { status: "idle" };
      },
      apply(tr, state) {
        const $rules = Array.isArray(rules) ? rules : rules();
        const meta = tr.getMeta(MATCH_DECORATION_KEY);
        const { selection } = tr;

        if ((meta === "end" && state.status !== "idle") || shouldSkipDecoration(tr)) {
          return { status: "idle" };
        }

        if (!selection.empty) return state;

        if (meta === "try-match" && state.status !== "match") {
          if (!selection.empty) return state;

          const textBefore = getTextBeforeSelection(selection);
          const textAfter = getTextAfterSelection(selection);
          const endOffset = findEndOffset(textAfter);

          const text = tr.doc.textBetween(
            0,
            selection.to + endOffset,
            "\n",
            (node) => node.attrs.label,
          );

          const length = text.length - textBefore.length - endOffset;
          const start = selection.$from.start();
          const { offset } = selection.$from.parent.childBefore(selection.$from.parentOffset);

          for (let i = 0; i < $rules.length; i++) {
            const rule = $rules[i];
            const triggerMatch = findTriggerMatch(text, rule.triggerRegExp);
            if (!triggerMatch) continue;

            const trigger = triggerMatch[0];
            const matchPosition = start + offset + (triggerMatch.index - length);

            const range = {
              from: matchPosition,
              to: selection.to + endOffset,
            };

            // Only create decoration if caret is after the trigger
            if (selection.empty && selection.from <= range.from) continue;

            const queryText = text.slice(triggerMatch.index + trigger.length);
            const queryMatch = findQueryMatch(queryText, rule.queryRegExp);
            if (!queryMatch) continue;

            const match = {
              trigger,
              triggerMatch,
              query: queryMatch[0],
              queryMatch,
              range,
            };
            if (rule.shouldMatch?.(match) === false) continue;

            return {
              status: "match",
              ...match,
              rule,
              ruleIndex: i,
              decorations: DecorationSet.create(tr.doc, [
                createDecoration(range.from, range.to, rule.attrs),
              ]),
            };
          }

          return state;
        }

        if (state.status === "idle") {
          if (!tr.docChanged) return state;

          const textBefore = getTextBeforeSelection(selection);
          const text = tr.doc.textBetween(0, selection.to, "\n", (node) => node.attrs.label);
          const length = text.length - textBefore.length;

          const start = selection.$from.start();
          const { offset } = selection.$from.parent.childBefore(selection.$from.parentOffset);

          for (let i = 0; i < $rules.length; i++) {
            const rule = $rules[i];
            const triggerMatch = findTriggerMatch(text, rule.triggerRegExp);
            if (!triggerMatch) continue;

            const trigger = triggerMatch[0];
            const matchPosition = start + offset + (triggerMatch.index - length);

            if (selection.from <= matchPosition) continue;

            const queryText = text.slice(triggerMatch.index + trigger.length);
            const queryMatch = findQueryMatch(queryText, rule.queryRegExp);
            if (!queryMatch) continue;

            const range = {
              from: matchPosition,
              to: selection.to,
            };

            const match = {
              trigger,
              triggerMatch,
              query: queryMatch[0],
              queryMatch,
              range,
            };
            if (rule.shouldMatch?.(match) === false) continue;

            return {
              status: "match",
              ...match,
              rule,
              ruleIndex: i,
              decorations: DecorationSet.create(tr.doc, [
                createDecoration(range.from, range.to, rule.attrs),
              ]),
            };
          }

          return state;
        }

        if (state.status === "match") {
          const decorations = state.decorations.map(tr.mapping, tr.doc);
          const [decoration] = decorations.find();
          if (
            !decoration ||
            selection.from < decoration.from ||
            selection.to > decoration.to ||
            (tr.docChanged && selection.from === decoration.from)
          ) {
            return { status: "idle" };
          }

          const text = tr.doc.textBetween(
            decoration.from,
            decoration.to,
            "\n",
            (node) => node.attrs.label,
          );

          for (let i = 0; i < $rules.length; i++) {
            const rule = $rules[i];
            const triggerMatch = findTriggerMatch(text, rule.triggerRegExp);
            if (!triggerMatch) continue;
            const trigger = triggerMatch[0];

            const queryText = text.slice(triggerMatch.index + trigger.length);
            const queryMatch = findQueryMatch(queryText, rule.queryRegExp);
            if (!queryMatch) continue;

            const range = {
              from: decoration.from,
              to: decoration.to,
            };
            const match = {
              trigger,
              triggerMatch,
              query: queryMatch[0],
              queryMatch,
              range,
            };
            if (rule.shouldMatch?.(match) === false) continue;

            const needsNewDecoration = i !== state.ruleIndex;

            return {
              status: "match",
              ...match,
              rule,
              ruleIndex: i,
              decorations: needsNewDecoration
                ? DecorationSet.create(tr.doc, [
                    createDecoration(decoration.from, decoration.to, rule.attrs),
                  ])
                : decorations,
            };
          }

          return { status: "idle" };
        }

        return state;
      },
    },
    props: {
      decorations(state) {
        const pluginState = this.getState(state);
        if (pluginState?.status !== "match") return DecorationSet.empty;

        return pluginState.decorations;
      },
    },
    view() {
      return {
        update(view, prevState) {
          const prev = MATCH_DECORATION_KEY.getState(prevState);
          const next = MATCH_DECORATION_KEY.getState(view.state);
          if (!prev || !next) return;

          const createParams = (state: MatchStatus) => ({
            range: state.range,
            trigger: state.trigger,
            triggerMatch: state.triggerMatch,
            query: state.query,
            queryMatch: state.queryMatch,
          });

          if (prev.status === "idle" && next.status === "match") {
            const params = createParams(next);
            onStart?.(params);
            onMatch?.(params);

            next.rule.onStart?.(params);
            next.rule.onMatch?.(params);
            return;
          }

          if (prev.status === "match" && next.status === "idle") {
            const params = createParams(prev);
            onEnd?.(params);
            prev.rule.onEnd?.(params);
            return;
          }

          if (
            prev.status === "match" &&
            next.status === "match" &&
            (prev.query !== next.query ||
              prev.range.from !== next.range.from ||
              prev.range.to !== next.range.to)
          ) {
            const params = createParams(next);
            onChange?.(params);
            onMatch?.(params);

            next.rule.onChange?.(params);
            next.rule.onMatch?.(params);
            return;
          }
        },
      };
    },
  });
}

export function tryMatch(tr: Transaction) {
  return tr.setMeta(MATCH_DECORATION_KEY, "try-match");
}

export function closeMatch(tr: Transaction) {
  return tr.setMeta(MATCH_DECORATION_KEY, "end");
}

function findTriggerMatch(text: string, regexp: RegExp) {
  regexp.lastIndex = 0;
  const matches = Array.from(text.matchAll(regexp));
  return matches.at(-1) ?? undefined;
}

function findQueryMatch(text: string, regexp: RegExp = DEFAULT_QUERY_REG_EXP) {
  regexp.lastIndex = 0;
  const match = regexp.exec(text);
  return match ?? undefined;
}

function getTextBeforeSelection(selection: Selection) {
  return selection.$from.nodeBefore?.isText ? (selection.$from.nodeBefore.text ?? "") : "";
}

function getTextAfterSelection(selection: Selection) {
  return selection.$from.nodeAfter?.isText ? (selection.$from.nodeAfter.text ?? "") : "";
}

function findEndOffset(text: string) {
  let endOffset = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      endOffset = i;
      break;
    }
    endOffset = i + 1;
  }
  return endOffset;
}
