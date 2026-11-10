<script lang="ts">
  import Icon from "@camber/components/icon";
  import { createTooltip, melt } from "@melt-ui/svelte";
  import { slide } from "svelte/transition";
  import { formatRelativeTimeWithoutAgo } from "../../shared/time";
  import type { ACPConversationSummary } from "../../navTypes";
  import { rpc } from "../../hostRpc";
  import { selectedValueName } from "../chat/menus/config/configOptions";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import DotsLoader from "../ui/DotsLoader.svelte";
  import Gauge from "../ui/Gauge.svelte";
  import MarkdownInline from "../ui/MarkdownInline.svelte";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";
  import {
    EMPTY_ACP_SESSION_METADATA,
    type ACPEditedFileMetadata,
  } from "../../features/session/SessionMetadata";
  import { appState } from "../../hostAdapter";
  import { shortenHomeDirectoryInText } from "../../shared/paths";
  import { getAcpSidebarController } from "./SidebarController.svelte";
  import { extractBranch, getRepositoryName, isValidUsage, truncate } from "./popoverHelpers";

  interface Props {
    session: ACPConversationSummary;
    agentName: string;
    iconUrl?: string;
    iconSize?: number;
    iconClass?: string;
    desktop?: boolean;
  }

  let {
    session,
    agentName,
    iconUrl,
    iconSize = 14,
    iconClass = "",
    desktop = false,
  }: Props = $props();

  const sidebar = getAcpSidebarController();
  const github = getACPGithubRepo();
  const TIMELINE_VALUE_LIMIT = 5;

  const liveSession = $derived(sidebar.liveSessionFor(session));

  const modelLabel = $derived.by(() => {
    if (!liveSession) return null;
    const opt = liveSession.configOptions.find(
      (o) => o.type === "select" && (o.category === "model" || o.id === "model"),
    );
    return opt ? selectedValueName(opt).trim() || null : null;
  });

  const usage = $derived(liveSession && isValidUsage(liveSession.usage) ? liveSession.usage : null);

  const planLines = $derived.by(() => {
    if (!liveSession?.plan || liveSession.plan.entries.length === 0) return [];
    const entries = liveSession.plan.entries;
    const completed = entries.filter((e) => e.status === "completed").length;
    const current =
      entries.find((e) => e.status === "in_progress") ??
      entries.find((e) => e.status === "pending");
    const lines = [`${completed} / ${entries.length} steps completed`];
    if (current?.content) lines.push(`current: ${truncate(current.content, 96)}`);
    return lines;
  });

  const metadata = $derived(
    liveSession?.metadata ?? session.metadata ?? EMPTY_ACP_SESSION_METADATA,
  );

  const updatedAtLabel = $derived(
    session.updatedAt ? formatRelativeTimeWithoutAgo(session.updatedAt) : null,
  );
  const repositoryName = $derived(getRepositoryName(session.cwd));
  // Full working directory, shown in a tooltip on the folder row.
  const directoryPath = $derived.by(() => {
    const cwd = session.cwd.trim();
    return cwd ? shortenHomeDirectoryInText(cwd, $appState.homeDirectory) : null;
  });

  let projectDetailsOpen = $state(false);
  let branch = $state<string | null | undefined>(undefined);

  // The shared preview component stays mounted while its target changes.
  // Reset target-local disclosure state instead of carrying it to the next row.
  $effect(() => {
    session.id;
    projectDetailsOpen = false;
    branch = undefined;
  });

  // Branch is fetched only if the user asks to see project details. Opening a
  // preview no longer sends host RPC just to render the collapsed summary.
  $effect(() => {
    const currentSession = liveSession;
    if (!currentSession || !projectDetailsOpen) return;
    let cancelled = false;
    rpc
      .getPromptContext()
      .then((facets) => {
        if (!cancelled) branch = extractBranch(facets);
      })
      .catch(() => {
        if (!cancelled) branch = null;
      });
    return () => {
      cancelled = true;
    };
  });

  type RowValue = string | ACPEditedFileMetadata;
  type Row = { label: string; values: RowValue[]; breakAll?: boolean };

  const timeline = $derived.by((): Row[] => {
    const hasMetadata =
      metadata.processes.length > 0 || metadata.explored.length > 0 || metadata.edited.length > 0;
    if (!liveSession && !hasMetadata) return [];
    const rows: Row[] = [
      {
        label: liveSession?.isPrompting ? "Processes Running" : "Processes Ran",
        values: metadata.processes,
      },
    ];
    if (metadata.explored.length > 0) {
      rows.push({ label: "Files Explored", values: metadata.explored, breakAll: true });
    }
    if (planLines.length > 0) rows.push({ label: "Drafting Plan", values: planLines });
    if (metadata.edited.length > 0) {
      rows.push({ label: "Files Edited", values: metadata.edited });
    }
    return rows;
  });

  const branchLabel = $derived(branch ?? (branch === undefined ? "loading" : "not available"));

  // Non-resident sessions cannot ask the host for a branch; the sidebar's
  // GitHub status cache covers tracked worktrees, so show it when known.
  const pastBranch = $derived(github.branchFor(session.cwd) || null);

  const pastFields = $derived(
    [
      { label: "Conversation", value: session.conversationKind },
      { label: "Cancelled", value: session.cancellationReason },
      { label: "Error", value: session.errorMessage },
    ].flatMap((f) => (f.value ? [f] : [])),
  );

  const {
    elements: { trigger: gaugeTooltipTrigger, content: gaugeTooltipContent },
    states: { open: gaugeTooltipOpen },
  } = createTooltip({
    positioning: { placement: "top", gutter: 4 },
    openDelay: 150,
    closeDelay: 0,
    forceVisible: true,
    disableHoverableContent: true,
  });

  const {
    elements: { trigger: pathTooltipTrigger, content: pathTooltipContent },
    states: { open: pathTooltipOpen },
  } = createTooltip({
    positioning: { placement: "top", gutter: 4 },
    openDelay: 150,
    closeDelay: 0,
    forceVisible: true,
    disableHoverableContent: true,
  });
</script>

{#snippet iconRow(name: "folder" | "git-branch", label: string)}
  <div class="text-psx-foreground-primary flex items-center gap-3">
    <Icon {name} size={14} class="text-psx-foreground-secondary shrink-0" />
    <span class="min-w-0 truncate">{label}</span>
  </div>
{/snippet}

{#snippet folderRow(label: string)}
  <div
    use:melt={$pathTooltipTrigger}
    class="text-psx-foreground-primary flex cursor-default items-center gap-3"
  >
    <Icon name="folder" size={14} class="text-psx-foreground-secondary shrink-0" />
    <span class="min-w-0 truncate">{label}</span>
  </div>
  {#if $pathTooltipOpen && directoryPath}
    <div
      use:melt={$pathTooltipContent}
      class="bg-psx-panel text-psx-foreground-primary shadow-mid z-50 max-w-96 break-all rounded-md px-2 py-1 text-sm"
    >
      {directoryPath}
    </div>
  {/if}
{/snippet}

{#snippet divider()}
  <!-- Full-bleed, so it has to give back exactly the card's own horizontal
       padding — which differs per variant (px-3 desktop, px-4 elsewhere).
       bleed-x reads that padding off the card rather than restating it, so a
       hardcoded inset cannot drift past the rounded edge again. -->
  <div
    class={[
      "bleed-x my-4 border-t",
      desktop ? "border-black/10 dark:border-white/10" : "border-psx-border opacity-50",
    ]}
  ></div>
{/snippet}

{#snippet projectDetails(branchRowLabel: string | null)}
  <div class="flex flex-col gap-2">
    <button
      type="button"
      class="text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus group flex w-full cursor-default items-center justify-between gap-2 rounded-[4px] focus-visible:outline-2"
      onclick={() => (projectDetailsOpen = !projectDetailsOpen)}
      aria-expanded={projectDetailsOpen}
    >
      <span>Project details</span>
      <Icon
        name="chevron"
        size={16}
        class={[
          "text-psx-foreground-tertiary group-hover:text-psx-foreground-primary shrink-0 transition-transform duration-200 ease-out",
          projectDetailsOpen && "rotate-180",
        ]}
      />
    </button>
    {#if projectDetailsOpen}
      <div class="flex flex-col gap-2" transition:slide={{ duration: 200, axis: "y" }}>
        {@render folderRow(repositoryName ?? "not available")}
        {#if branchRowLabel}
          {@render iconRow("git-branch", branchRowLabel)}
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- header -->
<div class="text-psx-foreground-primary flex items-center justify-between gap-2">
  <div class="flex min-w-0 items-center gap-3">
    <RegistryAgentIcon {iconUrl} size={iconSize} class={iconClass} />
    <span class="truncate">{modelLabel || agentName}</span>
  </div>
  {#if usage}
    <span use:melt={$gaugeTooltipTrigger} class="inline-flex">
      <Gauge
        size={16}
        color="var(--color-psx-bubble-background)"
        usedTokens={usage.used}
        totalTokens={usage.max}
      />
    </span>
    {#if $gaugeTooltipOpen}
      <div
        use:melt={$gaugeTooltipContent}
        class="bg-psx-panel text-psx-foreground-primary shadow-mid z-50 rounded-md px-2 py-1 text-sm"
      >
        {usage.used.toLocaleString()} / {usage.max.toLocaleString()} tokens used
      </div>
    {/if}
  {:else if updatedAtLabel}
    <span class="text-psx-foreground-tertiary shrink-0">{updatedAtLabel}</span>
  {/if}
</div>

<!-- body -->
<div class="mt-0">
  {#if liveSession || timeline.length > 0}
    <div class="flex flex-col">
      {#each timeline as row (row.label)}
        {@const visibleValues = row.values.slice(-TIMELINE_VALUE_LIMIT)}
        <div class="flex gap-3 pb-3 last:pb-0">
          <div class="flex flex-col items-center">
            <div class="flex h-4 items-center">
              <DotsLoader
                size={14}
                color="var(--color-psx-foreground-secondary)"
                animate={liveSession?.isPrompting ?? false}
              />
            </div>
            <div
              class="from-psx-border to-psx-border/0 mt-2 min-h-4 w-px flex-1 rounded-full bg-gradient-to-b"
            ></div>
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-psx-foreground-primary">{row.label}</span>
            {#if row.values.length > 0}
              <div
                class={[
                  "text-psx-foreground-secondary flex min-w-0 flex-col",
                  row.breakAll && "break-all",
                ]}
              >
                <div class={["flex flex-col", desktop ? "gap-1" : "gap-0.5"]}>
                  {#each visibleValues as value}
                    {#if typeof value === "string"}
                      <span class="block truncate" title={value}>
                        <MarkdownInline text={value} />
                      </span>
                    {:else}
                      <span class="flex min-w-0 items-baseline gap-1.5" title={value.filePath}>
                        <span class="text-psx-foreground-secondary min-w-0 break-all">
                          {value.fileName}
                        </span>
                        <span class="text-psx-foreground-tertiary min-w-0 flex-1 truncate text-xs">
                          {value.filePath}
                        </span>
                      </span>
                    {/if}
                  {/each}
                  {#if row.values.length > visibleValues.length}
                    <span class="text-psx-foreground-tertiary">
                      {row.values.length - visibleValues.length} more
                    </span>
                  {/if}
                </div>
              </div>
            {:else}
              <span class="text-psx-foreground-tertiary">No activity yet</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    {#if liveSession}
      {@render divider()}
      {@render projectDetails(branchLabel)}
    {/if}
  {/if}
  {#if !liveSession}
    {#if timeline.length > 0 && (pastFields.length > 0 || repositoryName)}
      {@render divider()}
    {/if}
    {#each pastFields as field (field.label)}
      <div class="flex items-start gap-2">
        <span class="text-psx-foreground-tertiary shrink-0">{field.label}</span>
        <span class="text-psx-foreground-secondary min-w-0 break-words">{field.value}</span>
      </div>
    {/each}
    {#if repositoryName}
      {#if pastFields.length > 0}{@render divider()}{/if}
      {@render projectDetails(pastBranch)}
    {/if}
  {/if}
</div>
