<script lang="ts">
  import { isPreviewableImagePath } from "@camber/components/assistant-ui";
  import { FileCodeView } from "@camber/components/file-diff";
  import { MarkdownBlock } from "@camber/components/markdown";
  import { Spinner } from "@camber/components/spinner";
  import { acpHostRpc as rpc, markdownHost } from "@camber/features/acp";

  // Mobile counterpart of the desktop file viewer panel: one full-screen page
  // per file, rendered as an image, rich markdown, or a read-only CodeMirror
  // view. Contents come through the host RPCs
  // the remote transport answers over /api/file.
  interface Props {
    path: string;
    line?: number;
  }

  const { path, line }: Props = $props();

  type Loaded =
    | { kind: "image"; src: string }
    | { kind: "markdown"; content: string }
    | { kind: "text"; content: string }
    | { kind: "binary" }
    | { kind: "missing" };

  let loaded = $state<Loaded | null>(null);
  let codeView = $state<ReturnType<typeof FileCodeView>>();
  let loadVersion = 0;

  const fileName = $derived(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);

  $effect(() => {
    const version = ++loadVersion;
    const currentPath = path;
    loaded = null;
    void loadFile(currentPath)
      .then((result) => {
        if (version !== loadVersion) return;
        loaded = result;
      })
      .catch(() => {
        // A rejected read (host RPC throwing while offline) must resolve the
        // spinner to the fallback instead of hanging on it forever.
        if (version === loadVersion) loaded = { kind: "missing" };
      });
  });

  async function loadFile(target: string): Promise<Loaded> {
    if (isPreviewableImagePath(target)) {
      const image = await rpc.getImageFileData(target);
      if (!image) return { kind: "missing" };
      return { kind: "image", src: `data:${image.mimeType};base64,${image.data}` };
    }
    const file = await rpc.getFileContents(target);
    if (file?.content == null) return { kind: "missing" };
    if (file.content.includes("\0")) return { kind: "binary" };
    if (/\.(md|markdown)$/i.test(target)) return { kind: "markdown", content: file.content };
    return { kind: "text", content: file.content };
  }

  // Deep-link to a line once the viewer has content (file chips carry
  // path:line references).
  $effect(() => {
    const view = codeView;
    if (!view || !line || loaded?.kind !== "text") return;
    view.revealLine(line);
  });
</script>

<div class="mobile-file-viewer">
  {#if loaded === null}
    <div class="mobile-file-status" role="status" aria-label="Loading file">
      <Spinner aria-hidden size={18} />
    </div>
  {:else if loaded.kind === "image"}
    <div class="mobile-file-image">
      <img src={loaded.src} alt={fileName} />
    </div>
  {:else if loaded.kind === "markdown"}
    <div class="mobile-file-markdown">
      <MarkdownBlock content={loaded.content} host={markdownHost} />
    </div>
  {:else if loaded.kind === "text"}
    <FileCodeView
      bind:this={codeView}
      class="mobile-file-code"
      content={loaded.content}
      filename={fileName}
      wrap
    />
  {:else if loaded.kind === "binary"}
    <div class="mobile-file-status">Binary file — no preview.</div>
  {:else}
    <div class="mobile-file-status">Unable to load {fileName}.</div>
  {/if}
</div>

<style>
  .mobile-file-viewer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--psx-editor-background);
  }

  .mobile-file-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px 16px;
    font-size: 13px;
    color: var(--psx-foreground-secondary, currentcolor);
  }

  .mobile-file-image {
    display: flex;
    justify-content: center;
    padding: 16px;
  }

  .mobile-file-image img {
    max-width: 100%;
    height: auto;
    object-fit: contain;
  }

  .mobile-file-markdown {
    padding: 12px 16px;
    font-size: 15px;
  }

  /* Pin a phone-readable size here because the
     surrounding app chrome sizes assume desktop defaults. iOS also auto-
     inflates text it deems too small — keep the size it renders the size we
     chose. */
  .mobile-file-viewer :global(.mobile-file-code) {
    flex: 1;
    min-height: 0;
    font-size: 13px;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  .mobile-file-viewer :global(.mobile-file-code.psx-file-code-view) {
    height: 100%;
  }
</style>
