<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import type {
    MCPServerEntry,
    LocalInferenceDownloadState,
    LocalInferenceModel,
  } from "@camber/helperapi/schemas";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { onDestroy, onMount } from "svelte";
  import { getLocalInferenceRepo } from "../features/LocalInferenceRepository.svelte";
  import {
    formatLocalInferenceBytes,
    formatLocalInferenceDownloadStats,
    formatOptionalLocalInferenceBytes,
    isActiveLocalInferenceDownload,
    localInferenceDownloadForModel,
    localInferenceDownloadProgressWidth,
    localInferenceDownloads,
  } from "../localInferenceDownload";
  import { getUserMCPServersRepo } from "../features/UserMCPServersRepository.svelte";
  import { rpc } from "../hostRpc";
  import { requestConnectorCatalogAdd } from "./mcp/connectorDeepLink";
  import { catalogCardClass } from "./settings/catalogCardStyles";
  import {
    dangerPillButtonClass,
    primaryPillButtonClass,
    secondaryPillButtonClass,
  } from "./settings/pillButtonStyles";
  import SettingsSection from "./settings/SettingsSection.svelte";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";
  import Tooltip from "./ui/Tooltip.svelte";

  interface Props {
    onShowConnectors?: () => void;
  }

  let { onShowConnectors }: Props = $props();

  const repo = getLocalInferenceRepo();
  const mcpServers = getUserMCPServersRepo();
  const SEARCH_DEBOUNCE_MS = 350;
  // Matches methods.LocalInferenceDownloadErrorCodeToSRequired in the helper.
  const TOS_REQUIRED_ERROR_CODE = "tos_required";
  const HUGGING_FACE_DOWNLOAD_SCOPES = ["openid", "profile", "read-mcp", "read-repos"];
  const HUGGING_FACE_DOWNLOAD_SCOPE = "read-repos";
  const TOS_RETRY_REFRESH_ATTEMPTS = 12;
  const TOS_RETRY_REFRESH_DELAY_MS = 1_000;
  const MLX_FRAMEWORK_URL = "https://mlx-framework.org";

  type RunEstimate = NonNullable<LocalInferenceModel["runEstimate"]>;

  type ModelMetadataItem = {
    label: string;
    value: string;
    href?: string;
  };

  type LocalInferenceDesktopRPC = typeof rpc & {
    openPathWithOpener(path: string, openerId: string): Promise<void>;
  };

  const desktopRpc = rpc as LocalInferenceDesktopRPC;

  let actionError = $state<string | null>(null);
  let pendingModelId = $state<string | null>(null);
  let searchQuery = $state("");
  let searchQueued = $state(false);
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);
  let searchResults = $state<LocalInferenceModel[]>([]);
  let lastSearchQuery = $state("");
  let searchRequestId = 0;
  let retryRefreshRun = 0;
  let pinnedSearchModelIds = $state<string[]>([]);
  let deleteConfirmModel = $state<LocalInferenceModel | null>(null);

  let inferenceState = $derived(repo.state);
  let models = $derived(inferenceState?.catalog ?? []);
  let camberModels = $derived(models.filter((model) => model.recommended));
  let installedHuggingFaceModels = $derived(
    models.filter((model) => !model.recommended && !isPinnedSearchModel(model)),
  );
  let searchResultModels = $derived(
    lastSearchQuery === searchQuery.trim()
      ? searchResults
          .filter(
            (result) =>
              isPinnedSearchModel(result) || !models.some((model) => sameModel(model, result)),
          )
          .map((result) => pinnedSearchDisplayModel(result))
      : [],
  );
  let downloads = $derived(localInferenceDownloads(inferenceState));
  let visibleError = $derived(actionError ?? repo.error);
  let searchBusy = $derived(searchQueued || searchLoading);
  // The search box lives in the Hugging Face section and scopes to it: a query
  // filters the installed Hugging Face models locally and appends installable
  // remote results. Recommended models are never filtered.
  let normalizedModelQuery = $derived(searchQuery.trim().toLowerCase());
  let matchingInstalledHuggingFaceModels = $derived(
    normalizedModelQuery
      ? installedHuggingFaceModels.filter((model) =>
          [model.name, model.repoId, model.provider].some((value) =>
            value?.toLowerCase().includes(normalizedModelQuery),
          ),
        )
      : installedHuggingFaceModels,
  );
  let visibleHuggingFaceModels = $derived([
    ...matchingInstalledHuggingFaceModels,
    ...searchResultModels,
  ]);
  let hasCheckedHuggingFaceConnector = $derived(mcpServers.isSupported !== null);
  let hasHuggingFaceConnector = $derived(
    mcpServers.servers.some((server) => isHuggingFaceConnector(server)),
  );

  onMount(() => {
    void repo.refresh().catch(() => {});
    if (!mcpServers.isLoading) {
      void mcpServers.load().catch(() => {});
    }
  });

  onDestroy(() => {
    retryRefreshRun += 1;
  });

  $effect(() => {
    const query = searchQuery.trim();
    searchError = null;

    if (!query) {
      searchRequestId += 1;
      searchQueued = false;
      searchLoading = false;
      searchResults = [];
      lastSearchQuery = "";
      pinnedSearchModelIds = [];
      return;
    }

    searchQueued = true;
    const timer = setTimeout(() => {
      searchQueued = false;
      void searchHuggingFaceModels(query);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      searchQueued = false;
    };
  });

  async function downloadModel(model: LocalInferenceModel): Promise<void> {
    await runModelAction(model.id, async () => {
      const startedFromSearchResults = searchResultModels.some((result) =>
        sameModel(result, model),
      );
      if (startedFromSearchResults) {
        pinSearchModel(model);
      }
      const download = downloadFor(model);
      const retryingToSDownload = Boolean(download && isToSAcceptanceError(download));
      if (retryingToSDownload) {
        const ready = await ensureHuggingFaceDownloadAccess();
        if (!ready) return;
      }
      await repo.downloadModel(model.id);
      if (retryingToSDownload) {
        void refreshAfterToSRetry(model);
      }
    });
  }

  async function pauseDownload(model: LocalInferenceModel): Promise<void> {
    await runModelAction(model.id, () => repo.cancelDownload(model.id));
  }

  function requestDeleteModel(model: LocalInferenceModel): void {
    deleteConfirmModel = model;
    actionError = null;
  }

  async function confirmDeleteModel(): Promise<void> {
    const model = deleteConfirmModel;
    if (!model) return;
    const deleted = await runModelAction(model.id, () => repo.deleteModel(model.id));
    if (!deleted) {
      // Rethrow so ConfirmationDialog surfaces the failure and stays open.
      throw new Error(actionError ?? "Unable to delete this model");
    }
    deleteConfirmModel = null;
  }

  async function runModelAction(modelId: string, action: () => Promise<void>): Promise<boolean> {
    if (pendingModelId) return false;
    pendingModelId = modelId;
    actionError = null;
    try {
      await action();
      return true;
    } catch (error) {
      actionError = getUnknownErrorMessage(error);
      return false;
    } finally {
      pendingModelId = null;
    }
  }

  async function refreshAfterToSRetry(model: LocalInferenceModel): Promise<void> {
    const run = ++retryRefreshRun;
    for (let attempt = 0; attempt < TOS_RETRY_REFRESH_ATTEMPTS; attempt += 1) {
      await delay(TOS_RETRY_REFRESH_DELAY_MS);
      if (run !== retryRefreshRun) return;
      try {
        await repo.refresh();
      } catch {
        return;
      }
      if (run !== retryRefreshRun || toSRetryRefreshSettled(model)) return;
    }
  }

  function toSRetryRefreshSettled(model: LocalInferenceModel): boolean {
    const state = repo.state;
    const current = state?.catalog.find((candidate) => sameModel(candidate, model));
    if (current?.downloaded) return true;
    const currentDownload = localInferenceDownloadForModel(localInferenceDownloads(state), model);
    return Boolean(currentDownload && !isActiveLocalInferenceDownload(currentDownload));
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function searchHuggingFaceModels(query: string): Promise<void> {
    const requestId = ++searchRequestId;
    searchLoading = true;
    searchError = null;
    lastSearchQuery = query;
    searchResults = [];
    try {
      const results = await repo.searchModels(query);
      if (!isActiveSearchRequest(requestId, query)) return;
      searchResults = results;
    } catch (error) {
      if (!isActiveSearchRequest(requestId, query)) return;
      searchResults = [];
      searchError = getUnknownErrorMessage(error);
    } finally {
      if (isActiveSearchRequest(requestId, query)) {
        searchLoading = false;
      }
    }
  }

  function isActiveSearchRequest(requestId: number, query: string): boolean {
    return requestId === searchRequestId && searchQuery.trim() === query;
  }

  function sameModel(a: LocalInferenceModel, b: LocalInferenceModel): boolean {
    return a.id === b.id || a.repoId === b.repoId || a.id === b.repoId || a.repoId === b.id;
  }

  function modelPlacementId(model: LocalInferenceModel): string {
    return model.repoId || model.id;
  }

  function isPinnedSearchModel(model: LocalInferenceModel): boolean {
    const id = modelPlacementId(model);
    return Boolean(id && pinnedSearchModelIds.includes(id));
  }

  function pinSearchModel(model: LocalInferenceModel): void {
    const id = modelPlacementId(model);
    if (!id || pinnedSearchModelIds.includes(id)) return;
    pinnedSearchModelIds = [...pinnedSearchModelIds, id];
  }

  function catalogModelFor(model: LocalInferenceModel): LocalInferenceModel | undefined {
    return models.find((candidate) => sameModel(candidate, model));
  }

  function pinnedSearchDisplayModel(result: LocalInferenceModel): LocalInferenceModel {
    if (!isPinnedSearchModel(result)) return result;
    const catalogModel = catalogModelFor(result);
    if (!catalogModel) return result;
    return {
      ...result,
      default: catalogModel.default,
      downloaded: catalogModel.downloaded,
      localPath: catalogModel.localPath,
      installedBytes: catalogModel.installedBytes,
      downloadBytes: catalogModel.downloadBytes || result.downloadBytes,
      download: catalogModel.download,
      runEstimate: catalogModel.runEstimate ?? result.runEstimate,
      gated: catalogModel.gated || result.gated,
      private: catalogModel.private || result.private,
      disabled: catalogModel.disabled || result.disabled,
    };
  }

  function hideBrokenImage(event: Event): void {
    const target = event.currentTarget;
    if (target instanceof HTMLImageElement) {
      target.hidden = true;
    }
  }

  function modelMetadata(model: LocalInferenceModel): ModelMetadataItem[] {
    const download = downloadFor(model);
    const downloadBytes = download?.bytesTotal || model.downloadBytes || model.installedBytes;
    return [
      metadataItem("Provider", model.provider),
      metadataItem("Quantization", model.quantization),
      metadataItem("Context", formatContextWindow(model.contextWindow)),
      metadataItem("Parameters", model.parameterSize),
      metadataItem(
        "Est. memory",
        model.runEstimate?.estimatedMemoryBytes
          ? formatLocalInferenceBytes(model.runEstimate.estimatedMemoryBytes)
          : undefined,
      ),
      metadataItem("Download size", formatOptionalLocalInferenceBytes(downloadBytes)),
      metadataItem(
        "Access",
        requiresHuggingFaceAccess(model) ? "Hugging Face access required" : undefined,
      ),
    ].filter((item): item is ModelMetadataItem => item != null);
  }

  function metadataItem(
    label: string,
    value: string | undefined,
    href?: string,
  ): ModelMetadataItem | undefined {
    if (!value) return undefined;
    return { label, value, href };
  }

  function isHuggingFaceConnector(server: MCPServerEntry): boolean {
    return Boolean(
      server.enabled &&
        isHuggingFaceConnectorCandidate(server) &&
        hasOAuthScope(server.oauthScopes, HUGGING_FACE_DOWNLOAD_SCOPE) &&
        !mcpServers.needsOAuthSignIn(server),
    );
  }

  function isHuggingFaceConnectorCandidate(server: MCPServerEntry): boolean {
    return Boolean(server.authMode === "oauth" && server.url && isHuggingFaceURL(server.url));
  }

  function isHuggingFaceURL(rawURL: string): boolean {
    try {
      const host = new URL(rawURL).hostname.toLowerCase();
      return host === "huggingface.co" || host.endsWith(".huggingface.co");
    } catch {
      return false;
    }
  }

  function hasOAuthScope(scopes: string | undefined, required: string): boolean {
    const normalizedRequired = required.toLowerCase();
    return (scopes ?? "")
      .split(/\s+/)
      .some((scope) => scope.trim().toLowerCase() === normalizedRequired);
  }

  function mergedHuggingFaceDownloadScopes(scopes: string | undefined): string {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const scope of [...(scopes ?? "").split(/\s+/), ...HUGGING_FACE_DOWNLOAD_SCOPES]) {
      const trimmed = scope.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
    return merged.join(" ");
  }

  async function ensureHuggingFaceDownloadAccess(): Promise<boolean> {
    if (mcpServers.isSupported === null || mcpServers.isLoading) {
      await mcpServers.load();
    }
    const existing = mcpServers.servers.find((server) => isHuggingFaceConnectorCandidate(server));
    if (!existing) {
      requestConnectorCatalogAdd("huggingface");
      onShowConnectors?.();
      return false;
    }

    const updated: MCPServerEntry = {
      ...existing,
      enabled: true,
      authMode: "oauth",
      oauthScopes: mergedHuggingFaceDownloadScopes(existing.oauthScopes),
    };
    if (
      !existing.enabled ||
      existing.authMode !== updated.authMode ||
      existing.oauthScopes !== updated.oauthScopes
    ) {
      await mcpServers.upsert(updated);
    }
    await mcpServers.authenticate(updated.name);
    await mcpServers.load();
    return true;
  }

  function requiresHuggingFaceAccess(model: LocalInferenceModel): boolean {
    return Boolean(model.gated || model.private);
  }

  function needsHuggingFaceConnector(model: LocalInferenceModel): boolean {
    return Boolean(
      requiresHuggingFaceAccess(model) &&
        hasCheckedHuggingFaceConnector &&
        !hasHuggingFaceConnector,
    );
  }

  function isCheckingHuggingFaceConnector(model: LocalInferenceModel): boolean {
    return Boolean(
      requiresHuggingFaceAccess(model) &&
        !hasCheckedHuggingFaceConnector &&
        !hasHuggingFaceConnector,
    );
  }

  async function openHuggingFaceConnector(): Promise<void> {
    if (pendingModelId) return;
    actionError = null;
    try {
      await ensureHuggingFaceDownloadAccess();
    } catch (error) {
      actionError = getUnknownErrorMessage(error);
    }
  }

  async function openModelFiles(path: string): Promise<void> {
    actionError = null;
    try {
      await desktopRpc.openPathWithOpener(path, "default");
    } catch (error) {
      actionError = getUnknownErrorMessage(error);
    }
  }

  function estimateLabel(estimate: RunEstimate): string {
    return estimate.confidence.charAt(0).toUpperCase() + estimate.confidence.slice(1);
  }

  function estimateClass(estimate: RunEstimate): string {
    if (estimate.confidence === "high") {
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    }
    if (estimate.confidence === "medium") {
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    }
    return "bg-psx-error-background text-psx-error-foreground";
  }

  function downloadFor(model: LocalInferenceModel): LocalInferenceDownloadState | undefined {
    if (model.download) return model.download;
    return localInferenceDownloadForModel(downloads, model);
  }

  function isActiveDownload(download: LocalInferenceDownloadState | null | undefined): boolean {
    return isActiveLocalInferenceDownload(download);
  }

  function isPartialDownload(
    model: LocalInferenceModel,
    download: LocalInferenceDownloadState | undefined,
  ): boolean {
    return (
      !model.downloaded &&
      ((model.installedBytes ?? 0) > 0 ||
        (download?.bytesDownloaded ?? 0) > 0 ||
        download?.status === "cancelled" ||
        download?.status === "failed")
    );
  }

  function canDeleteModel(
    model: LocalInferenceModel,
    download: LocalInferenceDownloadState | undefined,
  ): boolean {
    return model.downloaded || isPartialDownload(model, download);
  }

  function modelStatusLabel(download: LocalInferenceDownloadState | undefined): string | undefined {
    if (download?.status === "failed") return "Failed";
    return undefined;
  }

  function progressWidth(download: LocalInferenceDownloadState): string {
    return localInferenceDownloadProgressWidth(download);
  }

  function downloadLabel(download: LocalInferenceDownloadState): string {
    if (download.status === "resolving") return download.currentFile ?? "Resolving files";
    if (download.status === "failed") {
      if (isToSAcceptanceError(download)) return "Model requires ToS acceptance";
      return download.error ?? "Download failed";
    }
    if (download.status === "cancelled") return "Download paused";
    if (download.status === "completed") return "Download complete";
    if (download.currentFile) return `Downloading ${basename(download.currentFile)}`;
    return "Downloading";
  }

  function isToSAcceptanceError(download: LocalInferenceDownloadState): boolean {
    return download.status === "failed" && download.errorCode === TOS_REQUIRED_ERROR_CODE;
  }

  function modelTermsURL(model: LocalInferenceModel): string | undefined {
    return model.sourceUrl || (model.repoId ? `https://huggingface.co/${model.repoId}` : undefined);
  }

  function downloadDetail(download: LocalInferenceDownloadState): string {
    return formatLocalInferenceDownloadStats(download);
  }

  function basename(path: string): string {
    return path.split("/").pop() || path;
  }

  function formatHomePath(path: string): string {
    const homeDirectory = inferredHomeDirectory(path);
    if (!homeDirectory) return path;
    if (path === homeDirectory) return "~";
    if (path.startsWith(`${homeDirectory}/`)) return `~/${path.slice(homeDirectory.length + 1)}`;
    return path;
  }

  function inferredHomeDirectory(path: string): string | undefined {
    const candidates = [inferenceState?.modelsDirectory, path];
    for (const candidate of candidates) {
      const match = candidate?.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
      if (match) return match[0];
    }
    return undefined;
  }

  function formatContextWindow(value: number | undefined): string | undefined {
    if (!value) return undefined;
    return value >= 1000 ? `${Math.round(value / 1000)}k context` : `${value} context`;
  }

  function statusClass(
    model: LocalInferenceModel,
    download: LocalInferenceDownloadState | undefined,
  ): string {
    if (download?.status === "failed") return "text-psx-error-foreground bg-psx-error-background";
    if (isCheckingHuggingFaceConnector(model)) {
      return "text-psx-foreground-muted bg-psx-menu-active-background/30";
    }
    if (needsHuggingFaceConnector(model)) {
      return "text-amber-700 bg-amber-500/15 dark:text-amber-300";
    }
    if (model.downloaded || download?.status === "completed") {
      return "text-psx-foreground-primary bg-psx-menu-active-background/40";
    }
    return "text-psx-foreground-secondary bg-psx-chrome-hover";
  }
</script>

{#snippet mlxTerm()}
  <Tooltip placement="bottom" gutter={4} openDelay={200} interactive>
    {#snippet label()}
      <span class="block max-w-64 text-left">
        MLX is the machine learning framework for Apple silicon.
        <button
          type="button"
          title={MLX_FRAMEWORK_URL}
          class="outline-hidden focus-visible:outline-psx-focus inline-flex items-baseline gap-0.5 underline underline-offset-2 focus-visible:rounded-sm focus-visible:outline-2"
          onclick={() => rpc.openExternalURL(MLX_FRAMEWORK_URL)}
        >
          Learn more
          <Icon name="arrow-up-right" size={9} class="shrink-0 self-center" aria-hidden="true" />
        </button>
      </span>
    {/snippet}
    <span class="cursor-help underline decoration-dotted underline-offset-2">MLX</span>
  </Tooltip>
{/snippet}

{#snippet recommendedModelsSubtitle()}
  Local {@render mlxTerm()} models tested by Camber.
{/snippet}

{#snippet runEstimateTooltip(estimate: RunEstimate)}
  <span class="flex max-w-80 flex-col gap-1 text-left">
    <span class="font-medium">{estimate.summary}</span>
    {#each estimate.details ?? [] as detail}
      <span>{detail}</span>
    {/each}
  </span>
{/snippet}

{#snippet modelCard(model: LocalInferenceModel)}
  {@const download = downloadFor(model)}
  {@const busy = pendingModelId === model.id || isActiveDownload(download)}
  {@const metadata = modelMetadata(model)}
  {@const runEstimate = model.runEstimate}
  {@const partialDownload = isPartialDownload(model, download)}
  {@const statusLabel = modelStatusLabel(download)}
  {@const checkingConnector = isCheckingHuggingFaceConnector(model)}
  {@const needsConnector = needsHuggingFaceConnector(model)}
  <article class={`${catalogCardClass} flex min-w-0 cursor-default flex-col rounded-xl p-4`}>
    <div class="flex min-w-0 items-center gap-2">
      <span
        class="border-psx-border bg-psx-panel relative inline-grid size-8 shrink-0 place-items-center overflow-hidden rounded-[9px] border dark:border-black/10 dark:bg-white"
        aria-hidden="true"
      >
        {#if model.avatarUrl}
          <img
            src={model.avatarUrl}
            alt=""
            class="absolute inset-0 h-full w-full object-cover"
            onerror={hideBrokenImage}
          />
        {:else}
          <Icon name="package" size={18} class="text-psx-icon dark:text-neutral-500" />
        {/if}
      </span>
      <h3 class="text-psx-foreground-primary min-w-0 truncate text-[13px]/[18px] font-medium">
        {#if model.sourceUrl}
          <a
            class="hover:text-psx-foreground-primary inline-flex min-w-0 max-w-full items-center gap-1 underline-offset-2 hover:underline"
            href={model.sourceUrl}
            title={model.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <span class="min-w-0 truncate">{model.name}</span>
            <Icon name="arrow-up-right" size={12} class="shrink-0" />
          </a>
        {:else}
          {model.name}
        {/if}
      </h3>
      {#if runEstimate}
        <Tooltip placement="top" gutter={8} openDelay={200} class="shrink-0">
          {#snippet label()}
            {@render runEstimateTooltip(runEstimate)}
          {/snippet}
          <span class={["shrink-0 rounded-full px-1.5 py-0.5 text-xs", estimateClass(runEstimate)]}>
            Fit: {estimateLabel(runEstimate)}
          </span>
        </Tooltip>
      {/if}
      <div class="ml-auto flex shrink-0 items-center gap-2">
        {#if statusLabel}
          <span class={["shrink-0 rounded-full px-2 py-0.5 text-xs", statusClass(model, download)]}>
            {statusLabel}
          </span>
        {/if}
        {#if canDeleteModel(model, download)}
          <button
            type="button"
            class={dangerPillButtonClass}
            onclick={() => requestDeleteModel(model)}
            disabled={pendingModelId === model.id}
          >
            Delete
          </button>
        {/if}
        {#if isActiveDownload(download)}
          <button
            type="button"
            class={secondaryPillButtonClass}
            onclick={() => void pauseDownload(model)}
            disabled={pendingModelId === model.id}
          >
            {#if pendingModelId === model.id}
              <Spinner size={12} />
            {/if}
            Pause
          </button>
        {:else if !model.downloaded}
          {#if checkingConnector}
            <button type="button" class={primaryPillButtonClass} disabled>
              <Spinner size={12} />
              Checking access
            </button>
          {:else if needsConnector}
            <button type="button" class={primaryPillButtonClass} onclick={openHuggingFaceConnector}>
              Connect to Hugging Face
            </button>
          {:else}
            <button
              type="button"
              class={primaryPillButtonClass}
              onclick={() => void downloadModel(model)}
              disabled={busy}
            >
              {#if pendingModelId === model.id}
                <Spinner size={12} />
              {/if}
              {partialDownload ? "Resume" : "Download"}
            </button>
          {/if}
        {/if}
      </div>
    </div>

    {#if model.description}
      <p class="text-psx-foreground-secondary leading-4.5 mt-1.5 line-clamp-2 text-sm">
        {model.description}
      </p>
    {/if}

    {#if metadata.length > 0}
      <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        {#each metadata as item}
          <div class="min-w-0">
            <dt class="text-psx-foreground-tertiary truncate">{item.label}</dt>
            <dd class="text-psx-foreground-secondary mt-0.5 min-w-0 truncate">
              {#if item.href}
                <a
                  class="hover:text-psx-foreground-primary underline-offset-2 hover:underline"
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.value}
                </a>
              {:else}
                {item.value}
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    {/if}

    {#if needsConnector}
      <p class="text-psx-foreground-secondary mt-2 text-[12px]/[16px]">
        This model requires Hugging Face authentication to download.
      </p>
    {/if}

    {#if download && download.status !== "completed"}
      {@const termsURL = modelTermsURL(model)}
      <div class="mt-auto pt-3">
        <div
          class="text-psx-foreground-secondary mb-1 flex min-w-0 items-center justify-between gap-3 text-[11px]"
        >
          <span class="min-w-0 truncate">
            {downloadLabel(download)}
            {#if isToSAcceptanceError(download) && termsURL}
              <a
                class="text-psx-foreground-primary ml-2 inline-flex items-center gap-1 underline-offset-2 hover:underline"
                href={termsURL}
                title={termsURL}
                target="_blank"
                rel="noreferrer"
              >
                Accept on Hugging Face
                <Icon name="arrow-up-right" size={11} class="shrink-0" />
              </a>
            {/if}
          </span>
          {#if downloadDetail(download)}
            <span class="shrink-0">{downloadDetail(download)}</span>
          {/if}
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-gray-200 shadow-inner">
          {#if download.status === "resolving"}
            <div
              class="local-inference-progress-indeterminate h-full w-1/3 rounded-full bg-blue-500"
            ></div>
          {:else}
            <div
              class={[
                "h-full min-w-2 rounded-full transition-[width] duration-500 ease-out",
                download.status === "failed" ? "bg-psx-error-foreground" : "bg-blue-500",
              ]}
              style:width={progressWidth(download)}
            ></div>
          {/if}
        </div>
      </div>
    {/if}
  </article>
{/snippet}

{#if visibleError}
  <SettingsSection title="Models Error" subtitle="The local model catalog could not be loaded.">
    <div class="text-psx-error-foreground px-3 pb-3 pt-3 text-[13px]/[18px]">
      {visibleError}
    </div>
  </SettingsSection>
{/if}

<SettingsSection title="Recommended Models" subtitle={recommendedModelsSubtitle}>
  <div class="model-catalog flex flex-col gap-3 px-3 pb-4 pt-3">
    <div
      class="text-psx-foreground-secondary flex flex-col items-start gap-1 pl-4 text-[12px]/[17px]"
    >
      <span class="inline-flex min-w-0 items-center gap-1">
        <span>Models downloaded to</span>
        {#if inferenceState?.modelsDirectory}
          <button
            type="button"
            class="hover:text-psx-foreground-primary min-w-0 truncate font-mono underline-offset-2 hover:underline"
            aria-label={`Open models directory in Finder: ${formatHomePath(inferenceState.modelsDirectory)}`}
            title={inferenceState.modelsDirectory}
            onclick={() => void openModelFiles(inferenceState.modelsDirectory)}
          >
            {formatHomePath(inferenceState.modelsDirectory)}
          </button>
        {:else}
          <span class="font-mono">...</span>
        {/if}
      </span>
    </div>

    {#if repo.loading && !inferenceState}
      <div
        class="text-psx-foreground-secondary flex items-center justify-center gap-2 py-10 text-xs"
      >
        <Spinner size={14} />
        Loading models
      </div>
    {:else if models.length === 0}
      <div class="text-psx-foreground-secondary py-10 text-center text-xs">
        No local model catalog available
      </div>
    {:else if camberModels.length > 0}
      <div class="model-catalog-grid">
        {#each camberModels as model (model.id)}
          {@render modelCard(model)}
        {/each}
      </div>
    {:else}
      <div class="text-psx-foreground-secondary py-8 text-center text-xs">
        No recommended models available
      </div>
    {/if}
  </div>
</SettingsSection>

{#if models.length > 0}
  <SettingsSection
    title="Hugging Face models"
    subtitle="Search MLX models on Hugging Face and manage installed ones."
  >
    <div class="model-catalog flex flex-col gap-3 px-3 pb-4 pt-3">
      <label class="relative block w-full max-w-[24rem]">
        <span class="sr-only">Search MLX models on Hugging Face</span>
        {#if searchBusy}
          <Spinner
            size={14}
            class="text-psx-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          />
        {:else}
          <Icon
            name="search"
            size={15}
            class="text-psx-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          />
        {/if}
        <input
          bind:value={searchQuery}
          type="search"
          placeholder="Search MLX models on Hugging Face"
          autocomplete="off"
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          class="border-psx-input-border bg-psx-input-background text-psx-foreground-primary outline-hidden placeholder:text-psx-foreground-secondary focus-visible:outline-psx-focus h-9 w-full rounded-full border pl-9 pr-3 text-[13px]/[18px] focus-visible:outline-2"
        />
      </label>

      {#if searchError}
        <p class="text-psx-error-foreground text-xs">{searchError}</p>
      {/if}

      {#if visibleHuggingFaceModels.length > 0}
        <div class="model-catalog-grid">
          {#each visibleHuggingFaceModels as model (model.id)}
            {@render modelCard(model)}
          {/each}
        </div>
      {:else if normalizedModelQuery && lastSearchQuery === searchQuery.trim() && !searchBusy}
        <div
          class="border-psx-border bg-psx-panel text-psx-foreground-secondary rounded-lg border px-3 py-6 text-center text-[13px]/[18px]"
        >
          No installable MLX models found for “{lastSearchQuery}”.
        </div>
      {:else if !normalizedModelQuery}
        <p class="text-psx-foreground-secondary text-[13px]/[18px]">
          No Hugging Face models installed. Search to find installable MLX models.
        </p>
      {/if}
    </div>
  </SettingsSection>
{/if}

{#if deleteConfirmModel}
  {@const deleteModel = deleteConfirmModel}
  <ConfirmationDialog
    destructive
    title="Delete Model?"
    description={`Delete ${deleteModel.name} from disk. This removes the local model files and cannot be undone.`}
    detail={deleteModel.localPath ? formatHomePath(deleteModel.localPath) : undefined}
    confirmLabel="Delete from disk"
    onCancel={() => (deleteConfirmModel = null)}
    onConfirm={confirmDeleteModel}
  />
{/if}

<style>
  /* Mirrors .agent-catalog / .agent-catalog-grid in AgentConfigurationSection
     so models and agents settings share the same layout. */
  .model-catalog {
    width: 100%;
    max-width: 56rem;
  }

  .model-catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 27rem), 1fr));
    gap: 8px;
  }

  @keyframes local-inference-progress-slide {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(310%);
    }
  }

  .local-inference-progress-indeterminate {
    animation: local-inference-progress-slide 1.35s ease-in-out infinite;
  }
</style>
