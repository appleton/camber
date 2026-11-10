<script lang="ts" module>
  export interface DiffContext extends SetRequired<DiffProps, "newContent" | "oldContent"> {
    changes: DiffLinesResult["changes"];
    stats: DiffLinesResult["stats"];
  }

  export const [getDiffContext, setDiffContext] = createContext<DiffContext>();
</script>

<script lang="ts">
  import type { DiffLinesResult } from "@camber/diff";
  import { diffLines } from "@camber/diff";
  import { createContext, type Snippet } from "svelte";
  import type { LiteralUnion, SetRequired } from "type-fest";

  export interface DiffProps {
    /**
     * The original version of the text to compare
     */
    oldContent?: string;

    /**
     * The modified version of the text to compare
     */
    newContent?: string;

    /**
     * The original content-type
     */
    oldContentType?: LiteralUnion<"application/octet-stream", string>;

    /**
     * The modified content-type
     */
    newContentType?: LiteralUnion<"application/octet-stream", string>;

    /**
     * Original filename to help with language detection
     */
    oldFilename?: string;

    /**
     * Modified filename to help with language detection
     */
    newFilename?: string;

    /**
     * Whether to ignore case differences when computing the diff.
     * When enabled, changes in capitalization won't be highlighted as differences.
     * @default false
     */
    ignoreCase?: boolean;

    /**
     * Weather to ignore leading and trailing whitespace characters when checking if two lines are equal.
     * @default false
     */
    ignoreWhitespace?: boolean;

    /**
     * Callback fired when the diff is computed.
     */
    onDiff?: (diff: DiffLinesResult) => void;
  }

  type Props = DiffProps & {
    children?: Snippet<[DiffLinesResult]>;
  };

  let {
    children,
    oldContent = "",
    newContent = "",
    oldContentType,
    newContentType,
    oldFilename,
    newFilename,
    ignoreCase,
    ignoreWhitespace,
    onDiff,
  }: Props = $props();

  const diff = $derived.by<DiffLinesResult>(() => {
    if (newContentType === "application/octet-stream") {
      const isNew = !oldFilename;
      const isRename = oldFilename && oldFilename !== newFilename;
      const isModified = !isNew && !isRename;

      return {
        changes: [],
        stats: {
          additions: isNew || isModified ? 1 : 0,
          deletions: isModified ? 1 : 0,
        },
      };
    }

    return diffLines(oldContent, newContent, {
      ignoreWhitespace,
      ignoreCase,
    });
  });

  $effect(() => {
    onDiff?.(diff);
  });

  setDiffContext({
    get newContent() {
      return newContent;
    },
    get oldContent() {
      return oldContent;
    },
    get oldContentType() {
      return oldContentType;
    },
    get newContentType() {
      return newContentType;
    },
    get oldFilename() {
      return oldFilename;
    },
    get newFilename() {
      return newFilename;
    },
    get ignoreWhitespace() {
      return ignoreWhitespace;
    },
    get changes() {
      return diff.changes;
    },
    get stats() {
      return diff.stats;
    },
  });
</script>

{@render children?.(diff)}
