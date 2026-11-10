<script lang="ts">
  import { isPreviewableImagePath, Tooltip } from "@camber/components/assistant-ui";
  import { FileCodeView, type GitGutterDecorations } from "@camber/components/file-diff";
  import Icon from "@camber/components/icon";
  import { MarkdownBlock } from "@camber/components/markdown";
  import {
    buildDesktopImageContextMenuItems,
    DESKTOP_GIT_CHANGED_EVENT,
    DESKTOP_OPEN_DIFF_TAB_EVENT,
    markdownHost,
    parseGitGutterDecorations,
    performDesktopImageContextMenuAction,
    requestDesktopImageAttachment,
    showDesktopContextMenu,
    type DesktopImageContextMenuRPC,
    type DesktopFileViewerPanelProps,
    type DesktopOpenDiffTabEventDetail,
  } from "@camber/features/acp";
  import { camberGitDiffFile, camberGitStatus, type GitStatusOutput } from "@camber/helperapi";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { onMount, tick, untrack } from "svelte";

  import {
    DESKTOP_SETTINGS_CHANGED_EVENT,
    getDesktopSettings,
    getImageFileData,
    openPathWithOpener,
    readTextFile,
    revealPathInFinder,
    writeImageDataToPasteboard,
    writeImageToPasteboard,
    writeToClipboard,
    type DesktopFileOpener,
    type DesktopSettings,
  } from "./rpc/host";

  let {
    path,
    cwd,
    line,
    openToken,
    focusToken,
    initialCodeFontFamily,
    initialCodeFontSize,
    onFileContextChange,
  }: DesktopFileViewerPanelProps = $props();

  type LoadState = "idle" | "loading" | "ready" | "error";
  type ViewerMode = "text" | "markdown" | "image";

  const DEFAULT_CODE_FONT_FAMILY = "Menlo";
  const DEFAULT_CODE_FONT_SIZE = 13;

  let codeView = $state<ReturnType<typeof FileCodeView>>();
  let loadState = $state<LoadState>("idle");
  let viewerMode = $state<ViewerMode>("text");
  let errorMessage = $state("");
  let externalOpenError = $state("");
  let imageSrc = $state("");
  let markdownContent = $state("");
  let codeContent = $state("");
  let gitDecorations = $state<GitGutterDecorations>(emptyGitDecorations());
  let hasGitChanges = $state(false);
  let fileOpeners = $state<DesktopFileOpener[]>([]);
  let codeFontFamily = $state(normalizeCodeFontFamily(initialCodeFontFamily));
  let codeFontSize = $state(normalizeCodeFontSize(initialCodeFontSize));
  let loadVersion = 0;
  let gitDecorationsToken = 0;
  let previousFocusToken = 0;
  let previousOpenToken = 0;

  const displayPath = $derived(relativePathFromCwd(path, cwd));
  const gitRelativePath = $derived.by(() => {
    const worktree = cwd?.trim();
    if (!worktree) return undefined;
    const relative = relativePathFromCwd(path, worktree);
    if (!relative || relative === path) return undefined;
    return relative.replace(/\\/g, "/");
  });
  const canReviewDiff = $derived(hasGitChanges && gitRelativePath !== undefined);
  const imageContextMenuRpc: DesktopImageContextMenuRPC = {
    getImageFileData,
    openPathWithOpener,
    revealPathInFinder,
    writeImageDataToPasteboard,
    writeImageToPasteboard,
    writeToClipboard,
  };

  onMount(() => {
    void getDesktopSettings()
      .then(applyDesktopSettings)
      .catch((error) => console.debug("Unable to load desktop editor settings", error));

    const onSettingsChanged = (event: Event) => {
      applyDesktopSettings((event as CustomEvent<DesktopSettings>).detail);
    };
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
  });

  $effect(() => {
    const nextPath = path;
    untrack(() => void loadFile(nextPath));
  });

  $effect(() => {
    const token = openToken;
    if (token === previousOpenToken) return;
    previousOpenToken = token;
    void tick().then(jumpToLocation);
  });

  $effect(() => {
    const token = focusToken;
    if (!token || token === previousFocusToken) return;
    previousFocusToken = token;
    void tick().then(() => codeView?.focus());
  });

  $effect(() => {
    void path;
    void cwd;
    untrack(() => void refreshGitDecorations());
  });

  $effect(() => {
    const onGitChanged = () => void refreshGitDecorations();
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    return () => window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
  });

  async function loadFile(nextPath: string) {
    const version = ++loadVersion;
    loadState = "loading";
    errorMessage = "";
    externalOpenError = "";
    gitDecorations = emptyGitDecorations();
    hasGitChanges = false;
    onFileContextChange?.({ path: nextPath });

    try {
      if (isPreviewableImagePath(nextPath)) {
        const image = await getImageFileData(nextPath);
        if (version !== loadVersion) return;
        if (!image) throw new Error("Image files of this type cannot be opened in Camber.");

        codeContent = "";
        imageSrc = `data:${image.mimeType};base64,${image.data}`;
        markdownContent = "";
        viewerMode = "image";
        loadState = "ready";
        return;
      }

      const file = await readTextFile(nextPath);
      if (version !== loadVersion) return;

      onFileContextChange?.({ path: nextPath, content: file.contents });
      imageSrc = "";
      if (isMarkdownPath(nextPath)) {
        codeContent = "";
        markdownContent = file.contents;
        viewerMode = "markdown";
        loadState = "ready";
        return;
      }

      markdownContent = "";
      codeContent = file.contents;
      viewerMode = "text";
      loadState = "ready";
      await tick();
      jumpToLocation();
    } catch (error) {
      if (version !== loadVersion) return;
      codeContent = "";
      imageSrc = "";
      markdownContent = "";
      gitDecorations = emptyGitDecorations();
      viewerMode = "text";
      loadState = "error";
      errorMessage = getUnknownErrorMessage(error);
    }
  }

  async function refreshGitDecorations(): Promise<void> {
    const token = ++gitDecorationsToken;
    const worktree = cwd?.trim();
    const currentPath = path;
    const relative = gitRelativePath;
    if (!worktree || !relative) {
      gitDecorations = emptyGitDecorations();
      hasGitChanges = false;
      return;
    }

    let status: GitStatusOutput;
    try {
      status = await camberGitStatus({ path: worktree });
    } catch {
      if (token !== gitDecorationsToken || path !== currentPath) return;
      gitDecorations = emptyGitDecorations();
      hasGitChanges = false;
      return;
    }
    if (token !== gitDecorationsToken || path !== currentPath) return;
    if (!status.isRepo) {
      gitDecorations = emptyGitDecorations();
      hasGitChanges = false;
      return;
    }

    const staged = status.staged ?? [];
    const unstaged = status.unstaged ?? [];
    const untracked = status.untracked ?? [];
    const isUntracked = untracked.some((file) => file.path === relative);
    const isChanged = [...staged, ...unstaged, ...untracked].some((file) => file.path === relative);
    hasGitChanges = isChanged;
    if (!hasGitChanges) {
      gitDecorations = emptyGitDecorations();
      return;
    }

    try {
      const diff = await camberGitDiffFile({
        path: worktree,
        file: relative,
        head: !isUntracked,
        untracked: isUntracked,
      });
      if (token !== gitDecorationsToken || path !== currentPath) return;
      gitDecorations = diff.binary ? emptyGitDecorations() : parseGitGutterDecorations(diff.patch);
    } catch {
      if (token === gitDecorationsToken) gitDecorations = emptyGitDecorations();
    }
  }

  function openReviewDiff(): void {
    const worktreePath = cwd?.trim();
    const relativePath = gitRelativePath;
    if (!canReviewDiff || !worktreePath || !relativePath) return;
    window.dispatchEvent(
      new CustomEvent<DesktopOpenDiffTabEventDetail>(DESKTOP_OPEN_DIFF_TAB_EVENT, {
        detail: { worktreePath, relativePath },
      }),
    );
  }

  async function openInExternalEditor() {
    externalOpenError = "";
    try {
      await openPathWithOpener(path, "default");
    } catch (error) {
      externalOpenError = getUnknownErrorMessage(error);
    }
  }

  async function openImageContextMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    const action = await showDesktopContextMenu(
      buildDesktopImageContextMenuItems({
        currentOpenerId: imageViewerOpenerId(),
        fileOpeners: fileOpeners.map(({ id, label }) => ({ id, label })),
      }),
      { x: event.clientX, y: event.clientY },
    );
    if (!action) return;

    externalOpenError = "";
    try {
      await performDesktopImageContextMenuAction({
        actionId: action,
        path,
        relativePath: displayPath,
        rpc: imageContextMenuRpc,
        attachImage: requestDesktopImageAttachment,
      });
    } catch (error) {
      externalOpenError = getUnknownErrorMessage(error);
    }
  }

  function imageViewerOpenerId(): string {
    return fileOpeners.find((opener) => opener.kind === "inApp")?.id ?? "poolside";
  }

  function jumpToLocation() {
    if (!line) return;
    codeView?.revealLine(Math.max(1, line));
    codeView?.focus();
  }

  function applyDesktopSettings(settings: DesktopSettings) {
    fileOpeners = settings.fileOpeners;
    codeFontFamily = normalizeCodeFontFamily(settings.codeFontFamily);
    codeFontSize = normalizeCodeFontSize(settings.codeFontSize);
  }

  function normalizeCodeFontFamily(value: string | undefined): string {
    const trimmed = value?.trim() ?? "";
    return trimmed || DEFAULT_CODE_FONT_FAMILY;
  }

  function normalizeCodeFontSize(value: number | undefined): number {
    const fontSize = Math.round(Number(value));
    if (!Number.isFinite(fontSize)) return DEFAULT_CODE_FONT_SIZE;
    return Math.min(24, Math.max(8, fontSize));
  }

  function emptyGitDecorations(): GitGutterDecorations {
    return { added: [], modified: [], deletedAfter: [] };
  }

  function wordWrapForPath(nextPath: string): boolean {
    return nextPath.toLowerCase().endsWith(".txt");
  }

  function isMarkdownPath(nextPath: string): boolean {
    const lowerPath = nextPath.toLowerCase();
    return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown");
  }

  function relativePathFromCwd(nextPath: string, nextCwd: string | undefined): string {
    const trimmedCwd = nextCwd?.trim();
    if (!trimmedCwd) return nextPath;

    const normalizedPath = normalizePathForDisplay(nextPath);
    const normalizedCwd = normalizePathForDisplay(trimmedCwd);
    const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;

    if (normalizedPath.toLowerCase() === normalizedCwd.toLowerCase()) {
      return normalizedPath.split("/").pop() || normalizedPath;
    }
    if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
      return normalizedPath.slice(prefix.length);
    }

    return nextPath;
  }

  function normalizePathForDisplay(value: string): string {
    const normalized = value.replace(/\\/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  }
</script>

<div class="desktop-file-viewer">
  <div class="desktop-file-viewer-toolbar">
    <div class="desktop-file-viewer-title" title={path}>
      <Icon type="file" name={path} fallback="file" size={16} aria-hidden="true" />
      <span>{displayPath}</span>
    </div>
    <Tooltip text="Review Diff" placement="bottom" gutter={6} openDelay={300}>
      <button
        type="button"
        class="desktop-file-viewer-action"
        disabled={!canReviewDiff}
        aria-label="Review diff for {displayPath}"
        onclick={openReviewDiff}
      >
        <Icon name="diff" size={14} aria-hidden="true" />
      </button>
    </Tooltip>
    <Tooltip text="Open in external editor" placement="bottom" gutter={6} openDelay={300}>
      <button
        type="button"
        class="desktop-file-viewer-action"
        aria-label="Open in external editor"
        onclick={() => void openInExternalEditor()}
      >
        <Icon name="arrow-up-right" size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  </div>

  <div class="desktop-file-viewer-body">
    <div
      class="desktop-file-viewer-editor"
      class:desktop-file-viewer-editor--hidden={loadState !== "ready" || viewerMode !== "text"}
    >
      <FileCodeView
        bind:this={codeView}
        content={codeContent}
        filename={path}
        {gitDecorations}
        wrap={wordWrapForPath(path)}
        fontFamily={codeFontFamily}
        fontSize={codeFontSize}
      />
    </div>
    {#if loadState === "ready" && viewerMode === "image"}
      <div class="desktop-file-viewer-image-frame">
        <img src={imageSrc} alt={displayPath} oncontextmenu={openImageContextMenu} />
      </div>
    {:else if loadState === "ready" && viewerMode === "markdown"}
      <div class="desktop-file-viewer-markdown-frame">
        <MarkdownBlock content={markdownContent} host={markdownHost} />
      </div>
    {/if}
    {#if loadState === "loading"}
      <div class="desktop-file-viewer-message">Loading file...</div>
    {:else if loadState === "error"}
      <div class="desktop-file-viewer-message desktop-file-viewer-message--error">
        {errorMessage || "Unable to open file."}
      </div>
    {/if}
  </div>

  {#if externalOpenError}
    <div class="desktop-file-viewer-error">{externalOpenError}</div>
  {/if}
</div>

<style lang="postcss">
  .desktop-file-viewer {
    display: flex;
    height: 100%;
    min-height: 0;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--psx-editor-background);
    color: var(--psx-foreground-primary);
  }

  .desktop-file-viewer-toolbar {
    display: flex;
    min-height: 34px;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--psx-border);
    padding: 0 8px;
  }

  .desktop-file-viewer-title {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 6px;
    color: var(--psx-foreground-secondary);
    font-size: 12px;
  }

  .desktop-file-viewer-title span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .desktop-file-viewer-action {
    display: inline-flex;
    height: 24px;
    width: 24px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--psx-foreground-secondary);
    cursor: pointer;
  }

  .desktop-file-viewer-action:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  .desktop-file-viewer-action:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .desktop-file-viewer-action:focus-visible {
    outline: 2px solid var(--psx-focus);
    outline-offset: 1px;
  }

  .desktop-file-viewer-body {
    position: relative;
    min-height: 0;
    min-width: 0;
    flex: 1;
  }

  .desktop-file-viewer-editor {
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  .desktop-file-viewer-editor :global(.psx-file-code-view) {
    height: 100%;
  }

  .desktop-file-viewer-editor--hidden {
    visibility: hidden;
  }

  .desktop-file-viewer-image-frame {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 16px;
    background: var(--psx-editor-background);
  }

  .desktop-file-viewer-image-frame img {
    max-height: 100%;
    max-width: 100%;
    object-fit: contain;
  }

  .desktop-file-viewer-markdown-frame {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 18px 24px 32px;
    background: var(--psx-editor-background);
  }

  .desktop-file-viewer-message {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    color: var(--psx-foreground-secondary);
    font-size: 13px;
    text-align: center;
  }

  .desktop-file-viewer-message--error {
    color: var(--psx-error-foreground);
  }

  .desktop-file-viewer-error {
    border-top: 1px solid var(--psx-border);
    padding: 6px 10px;
    color: var(--psx-error-foreground);
    font-size: 12px;
  }
</style>
