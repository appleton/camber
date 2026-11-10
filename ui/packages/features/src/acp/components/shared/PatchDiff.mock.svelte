<script lang="ts">
  // Test stand-in for @camber/components/file-diff PatchDiff: jsdom
  // cannot host @pierre/diffs' shadow-DOM renderer, so render the new-side
  // text (or raw patch) so assertions still see the diff content.
  interface MockFileContents {
    name: string;
    contents: string;
  }

  interface Props {
    patch?: string;
    oldFile?: MockFileContents;
    newFile?: MockFileContents;
    [key: string]: unknown;
  }

  let { patch = "", newFile = undefined }: Props = $props();
</script>

<div data-testid="patch-diff-mock">{newFile?.contents ?? patch}</div>
