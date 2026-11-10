<script lang="ts">
  import { MarkdownBlock } from "@camber/components/markdown";
  import dependencyLicenses from "../../../../THIRD-PARTY-DEPENDENCIES.md?raw";
  import thirdPartyLicenses from "../../../../THIRD-PARTY-LICENSES.md?raw";

  let scroller: HTMLElement;

  const firstSectionIndex = thirdPartyLicenses.search(/^## /m);
  const documentTitle = thirdPartyLicenses.slice(0, thirdPartyLicenses.indexOf("\n")).trim();
  const vendoredSections =
    firstSectionIndex === -1 ? thirdPartyLicenses : thirdPartyLicenses.slice(firstSectionIndex);
  const renderedLicenses =
    firstSectionIndex === -1
      ? `${thirdPartyLicenses.trim()}\n\n${dependencyLicenses.trim()}\n`
      : `${documentTitle}\n\n${dependencyLicenses.trim()}\n\n${vendoredSections.trim()}\n`;
</script>

<main bind:this={scroller} aria-label="Third Party Licenses">
  <article>
    <MarkdownBlock content={renderedLicenses} scrollElement={scroller} />
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
    width: min(100%, 1040px);
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
