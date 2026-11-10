<script lang="ts">
  import Icon from "@camber/components/icon";
  import { onMount, tick } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { GitHubWorktreeStatus } from "../../github/githubStatus";
  import {
    githubChecksCountLabel,
    githubCommentsCountLabel,
    githubReviewDecisionLabel,
    type GitHubPRDetail,
  } from "../../github/githubStatus";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";

  interface Props {
    anchorId: string;
    triggerId?: string;
    path: string;
    status?: GitHubWorktreeStatus;
  }

  let { anchorId, triggerId = anchorId, path, status }: Props = $props();

  const github = getACPGithubRepo();
  let detailStatus = $state<GitHubPRDetail | null>(null);
  let detailBranch = $state("");
  let detailLoadedPath = $state("");
  let detailLoading = $state(false);
  let statusKey = $derived(
    `${path}:${status?.status.number ?? 0}:${status?.status.updatedAt ?? ""}`,
  );
  let pr = $derived(detailStatus ?? status?.status);
  let branch = $derived(detailBranch || status?.branch || "");
  let hasPR = $derived(Boolean(pr && pr.state !== "none"));
  let anchorElement = $state<HTMLElement | null>(null);
  let triggerElement = $state<HTMLElement | null>(null);
  let tooltipElement = $state<HTMLElement | null>(null);
  let open = $state(false);
  let left = $state(0);
  let top = $state(0);

  const tooltipId = `${anchorId}-tooltip`;
  const VIEWPORT_MARGIN = 8;
  const ANCHOR_OFFSET = 6;

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function portalToBody(): Attachment {
    return (element: Element) => {
      document.body.appendChild(element);
      return () => {
        element.remove();
      };
    };
  }

  function updatePosition({ force = false }: { force?: boolean } = {}) {
    if (!open && !force) return;
    const positionElement = triggerElement ?? anchorElement;
    if (!positionElement) return;
    const anchorRect = positionElement.getBoundingClientRect();
    const tooltipRect = tooltipElement?.getBoundingClientRect();
    const tooltipWidth = tooltipRect?.width ?? 0;
    const tooltipHeight = tooltipRect?.height ?? 0;
    left = clamp(
      anchorRect.left,
      VIEWPORT_MARGIN,
      window.innerWidth - tooltipWidth - VIEWPORT_MARGIN,
    );
    top = clamp(
      anchorRect.bottom + ANCHOR_OFFSET,
      VIEWPORT_MARGIN,
      window.innerHeight - tooltipHeight - VIEWPORT_MARGIN,
    );
  }

  async function updatePositionAfterRender() {
    await tick();
    updatePosition({ force: true });
  }

  function updatePositionFromViewportChange() {
    updatePosition();
  }

  function show() {
    if (!hasPR) return;
    open = true;
    void updatePositionAfterRender();
    void loadDetail();
  }

  function hide() {
    open = false;
  }

  async function loadDetail() {
    if (detailLoading || detailLoadedPath === path) return;
    detailLoading = true;
    try {
      const result = await github.prDetail(path);
      if (result.detail) {
        detailLoadedPath = path;
        detailStatus = result.detail;
        detailBranch = result.branch;
      }
    } catch {
      // Keep the compact sidebar status when detail refresh fails.
    } finally {
      detailLoading = false;
    }
  }

  $effect(() => {
    statusKey;
    detailStatus = null;
    detailBranch = "";
    detailLoadedPath = "";
  });

  $effect(() => {
    if (!open) return;
    if (!hasPR) {
      hide();
      return;
    }
    pr;
    branch;
    path;
    void updatePositionAfterRender();
  });

  $effect(() => {
    if (!open || !anchorElement) return;
    anchorElement.setAttribute("aria-describedby", tooltipId);
    document.addEventListener("contextmenu", hide);
    window.addEventListener("scroll", updatePositionFromViewportChange, true);
    window.addEventListener("resize", updatePositionFromViewportChange);

    return () => {
      anchorElement?.removeAttribute("aria-describedby");
      document.removeEventListener("contextmenu", hide);
      window.removeEventListener("scroll", updatePositionFromViewportChange, true);
      window.removeEventListener("resize", updatePositionFromViewportChange);
    };
  });

  onMount(() => {
    anchorElement = document.getElementById(anchorId);
    triggerElement = document.getElementById(triggerId);
    if (!anchorElement || !triggerElement) return;
    triggerElement.addEventListener("pointerenter", show);
    triggerElement.addEventListener("pointerleave", hide);
    anchorElement.addEventListener("contextmenu", hide);
    anchorElement.addEventListener("focusin", show);
    anchorElement.addEventListener("focusout", hide);

    return () => {
      triggerElement?.removeEventListener("pointerenter", show);
      triggerElement?.removeEventListener("pointerleave", hide);
      anchorElement?.removeEventListener("contextmenu", hide);
      anchorElement?.removeEventListener("focusin", show);
      anchorElement?.removeEventListener("focusout", hide);
    };
  });
</script>

{#if open && pr}
  <span
    id={tooltipId}
    bind:this={tooltipElement}
    {@attach portalToBody()}
    role="tooltip"
    class="bg-psx-panel text-psx-foreground-primary shadow-overlay dark:shadow-overlay-dark pointer-events-none fixed z-[100] block w-64 rounded-[6px] p-2 text-xs"
    style:left={`${left}px`}
    style:top={`${top}px`}
  >
    <span class="flex min-w-0 items-start gap-2">
      <Icon name="github" size={14} class="text-psx-foreground-secondary mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0 font-medium">PR #{pr.number}</span>
          <span class="text-psx-foreground-tertiary min-w-0 truncate">{pr.state}</span>
        </span>
        <span class="mt-0.5 line-clamp-2 text-[12px]/[15px]">{pr.title}</span>
        <span class="text-psx-foreground-secondary mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
          <span class="min-w-0 truncate">{githubChecksCountLabel(pr)}</span>
          <span class="min-w-0 truncate">{githubCommentsCountLabel(pr)}</span>
          <span class="col-span-2 min-w-0 truncate">{githubReviewDecisionLabel(pr)}</span>
          {#if branch}
            <span class="col-span-2 min-w-0 truncate">Branch: {branch}</span>
          {/if}
          <span class="col-span-2 min-w-0 truncate">Path: {path}</span>
        </span>
      </span>
    </span>
  </span>
{/if}
