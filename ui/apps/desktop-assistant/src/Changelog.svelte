<script lang="ts">
  import { MarkdownBlock } from "@camber/components/markdown";
  // Stamped by the release workflow (render-changelog); the committed file is
  // a placeholder, so dev builds show just the heading.
  import changelog from "../CHANGELOG.md?raw";

  let scroller: HTMLElement;
</script>

<main bind:this={scroller} aria-label="Changelog">
  <article>
    <MarkdownBlock content={changelog} scrollElement={scroller} />
  </article>
</main>

<style>
  main {
    box-sizing: border-box;
    height: 100%;
    overflow-y: auto;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }

  article {
    box-sizing: border-box;
    width: min(100%, 760px);
    min-height: 100%;
    margin: 0 auto;
    padding: 40px 56px 72px;
  }

  @media (max-width: 600px) {
    article {
      padding: 28px 24px 48px;
    }
  }
</style>
