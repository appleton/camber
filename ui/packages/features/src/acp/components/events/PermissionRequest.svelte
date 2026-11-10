<script lang="ts">
  import type { PermissionOption, ToolKind } from "@agentclientprotocol/sdk";
  import type { ToolCall } from "../../types";
  import { insideModalOverlay, isAppleUser } from "@camber/components";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { DEFAULT_AGENT_SERVER } from "../../agentServers";
  import { agentName as getAgentName } from "../chat/menus/config/agentConfig";
  import { Button } from "@camber/components/button";
  import Icon from "@camber/components/icon";
  import Kbd from "@camber/components/kbd";
  import { createDropdownMenu, melt } from "@melt-ui/svelte";
  import { HighlightedShellCommand } from "@camber/components/assistant-ui";
  import type { ACPPendingPermissionRequest } from "../../features/Session.svelte";
  import { ACP_PERMISSION_SUGGESTED_RULES_META_KEY } from "../../permissionMeta";
  import { getToolCommand, getToolCommandLabel, getToolDescription } from "../shared/toolStatus";
  import { appState } from "../../hostAdapter";
  import { getACPContext } from "../../features/SessionRepository.svelte";
  import ToolCallContentRenderer from "../shared/ToolCallContentRenderer.svelte";
  import { getKeybindingService, matchesChord, type Platform } from "../../../keybindings";
  import { supportsNativeMenus } from "../chat/desktopContextMenu";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";

  // Approve/Reject chords come from the shared keybindings registry so they're listed
  // in settings and (on desktop) user-configurable. This component owns the dispatch on
  // every host — it knows the pending request and works inside the VS Code webview, where
  // the global desktop dispatcher does not run.
  const keybindings = getKeybindingService();
  const platform: Platform = isAppleUser() ? "mac" : "other";
  const approveChord = $derived(keybindings?.binding("approve") ?? "alt+a");
  const rejectChord = $derived(keybindings?.binding("reject") ?? "escape");
  const approveHint = $derived(keybindings?.hint("approve") ?? (isAppleUser() ? "⌥A" : "Alt+A"));
  const rejectHint = $derived(keybindings?.hint("reject") ?? "esc");

  type ApprovalOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

  const LABELS: Record<Exclude<ToolKind, "other">, string> = {
    read: "Read",
    edit: "Edit",
    delete: "Delete",
    move: "Move",
    search: "Search",
    execute: "Run",
    think: "Think",
    fetch: "Fetch",
    switch_mode: "Switch mode",
  };

  interface Props {
    request: ACPPendingPermissionRequest;
    toolCallContext?: ToolCall;
  }

  let { request, toolCallContext }: Props = $props();

  const acp = getACPContext();
  const registry = getACPAgentRegistryRepo();
  // Keyboard hints are noise on a touch surface with no hardware keyboard.
  const showKeyHints = $derived($appState.environment.assistantHost !== "mobile");
  const currentAgentServer = request.agentServer ?? DEFAULT_AGENT_SERVER;
  const currentAgentName = $derived(getAgentName(registry, currentAgentServer));

  let isSubmitting = $state(false);
  let containerDiv: HTMLDivElement | undefined = $state();
  let focusIndex = $state(0);
  let allowShortcutOption = $derived(findOptionByKinds(["allow_once"]));
  let denyShortcutOption = $derived(findOptionByKinds(["reject_once", "reject_always"]));
  let alwaysAllowOption = $derived(findOptionByKinds(["allow_always"]));
  let suggestedRules = $derived(alwaysAllowOption ? getSuggestedRules(alwaysAllowOption) : []);
  let showAllSubCommandsButton = $derived(suggestedRules.length > 4);
  let displayToolCall = $derived(toolCallContext ?? request.toolCall);
  let command = $derived(getToolCommand(displayToolCall));
  let hasContent = $derived((displayToolCall.content?.length ?? 0) > 0);
  let actionLabel = $derived(command ? "execute" : getActionLabel(request.toolCall.kind));
  let description = $derived(getToolDescription(displayToolCall));
  let headerSubject = $derived(
    getToolCommandLabel(request.toolCall) ??
      getToolCommandLabel(displayToolCall) ??
      request.toolCall.title,
  );
  let rawInput = $derived(
    request.toolCall.rawInput == null
      ? undefined
      : typeof request.toolCall.rawInput === "string"
        ? request.toolCall.rawInput
        : JSON.stringify(request.toolCall.rawInput, null, 2),
  );

  // Broader glob variants for each suggested rule (e.g. "gh pr checks 31268 *"
  // -> ["gh pr checks *", "gh pr *", "gh *"]). Camber ACP can persist the
  // selected override via RequestPermissionOutcomeSelected._meta.
  let suggestedRuleAlternatives = $derived.by(() => {
    const seen = new Set<string>(suggestedRules);
    const out: string[] = [];
    for (const rule of suggestedRules) {
      for (const variant of progressiveGlobVariants(rule)) {
        if (!seen.has(variant)) {
          seen.add(variant);
          out.push(variant);
        }
      }
    }
    return out;
  });

  const alternativesMenu = createDropdownMenu({
    positioning: { placement: "bottom-end" },
    forceVisible: true,
  });
  const {
    elements: { trigger: alternativesTrigger, menu: alternativesMenuEl },
    states: { open: alternativesOpen },
  } = alternativesMenu;

  // Native menu path for the "Instead, always allow" alternatives list. Built
  // from the same `suggestedRuleAlternatives` the DOM popover renders, so the
  // set of variants and their order always match.
  const nativeMenus = $derived(supportsNativeMenus($appState.environment));
  const alternativesMenuItems = $derived<MenuSpecItem[]>(
    suggestedRuleAlternatives.map((variant) => ({ kind: "action", id: variant, label: variant })),
  );
  const alternativesTriggerClass =
    "bg-psx-button-secondary-background text-psx-button-secondary-foreground hover:bg-psx-button-secondary-hover-background focus-visible:outline-psx-focus ui-xs:min-h-6 ui-sm:min-h-7 ui-md:min-h-8 ui-lg:min-h-9 flex items-center justify-center rounded-r px-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 active:brightness-110 disabled:pointer-events-none disabled:opacity-50";

  let alternativesTriggerButton: HTMLButtonElement | undefined = $state();
  let nativeAlternativesOpen = $state(false);

  async function openAlternativesNativeMenu(optionId: string): Promise<void> {
    if (!alternativesTriggerButton || nativeAlternativesOpen || isSubmitting) return;
    const rect = alternativesTriggerButton.getBoundingClientRect();
    nativeAlternativesOpen = true;
    try {
      const variant = await presentNativeMenu(alternativesMenuItems, {
        x: rect.right,
        y: rect.bottom + 4,
        align: "end",
      });
      if (variant !== undefined) selectOption(optionId, overrideRulesForVariant(variant));
    } finally {
      nativeAlternativesOpen = false;
    }
  }

  function findOptionByKinds(kinds: ApprovalOptionKind[]): PermissionOption | undefined {
    for (const kind of kinds) {
      const option = request.options.find((candidate) => candidate.kind === kind);
      if (option) {
        return option;
      }
    }

    return undefined;
  }

  function getActionLabel(kind: ToolKind | null | undefined): string {
    if (!kind || kind === "other") return "use";
    return kind === "execute" ? "execute" : LABELS[kind].toLowerCase();
  }

  function optionLabel(option: PermissionOption): string {
    switch (option.kind) {
      case "allow_once":
        return "Allow Once";
      case "reject_once":
      case "reject_always":
        return "Deny";
      default:
        return option.name;
    }
  }

  function getSuggestedRules(option: PermissionOption): string[] {
    const raw = option._meta?.[ACP_PERMISSION_SUGGESTED_RULES_META_KEY];
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.every((item): item is string => typeof item === "string") ? raw : [];
  }

  function progressiveGlobVariants(rule: string): string[] {
    if (!rule.endsWith(" *")) return [];
    const prefix = rule.slice(0, -2);
    const tokens = prefix.split(/\s+/).filter(Boolean);
    if (tokens.length <= 1) return [];
    const variants: string[] = [];
    for (let i = tokens.length - 1; i >= 1; i--) {
      variants.push(tokens.slice(0, i).join(" ") + " *");
    }
    return variants;
  }

  function ruleTokens(rule: string): string[] | null {
    if (!rule.endsWith(" *")) return null;
    return rule.slice(0, -2).split(/\s+/).filter(Boolean);
  }

  function variantSubsumes(variant: string, rule: string): boolean {
    const v = ruleTokens(variant);
    const r = ruleTokens(rule);
    if (!v || !r || v.length > r.length) return false;
    return v.every((tok, i) => tok === r[i]);
  }

  function overrideRulesForVariant(variant: string): string[] {
    const kept = suggestedRules.filter((rule) => !variantSubsumes(variant, rule));
    return [variant, ...kept];
  }

  function selectOption(optionId: string, overrideRules?: string[]): void {
    if (isSubmitting) return;
    isSubmitting = true;
    if (overrideRules && overrideRules.length > 0) {
      acp.selectPermissionOption(request.id, optionId, overrideRules);
      return;
    }
    acp.selectPermissionOption(request.id, optionId);
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Keystrokes inside a modal overlay (e.g. the conversation search) belong
    // to that overlay: Escape there closes it, it must not reject the request.
    if (insideModalOverlay(e.target)) return;

    if (denyShortcutOption && matchesChord(e, rejectChord, platform)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectOption(denyShortcutOption.optionId);
      return;
    }

    if (allowShortcutOption && matchesChord(e, approveChord, platform)) {
      e.preventDefault();
      selectOption(allowShortcutOption.optionId);
      return;
    }

    if (e.code === "ArrowDown" || e.code === "ArrowUp") {
      e.preventDefault();

      if (!containerDiv) return;

      const buttons = Array.from(containerDiv.querySelectorAll("button:not([disabled])"));
      if (buttons.length === 0) return;

      const currentIndex = buttons.findIndex((btn) => btn === document.activeElement);
      if (currentIndex !== -1) {
        focusIndex = currentIndex;
      }

      if (e.code === "ArrowDown") {
        focusIndex = (focusIndex + 1) % buttons.length;
      } else {
        focusIndex = (focusIndex - 1 + buttons.length) % buttons.length;
      }

      (buttons[focusIndex] as HTMLElement)?.focus();
    }
  }
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<div
  data-testid="acp-permission-request"
  class="bg-psx-editor-background outline-psx-border text-auto shadow-high dark:shadow-high-dark border-psx-border isolate flex max-w-full shrink-0 flex-col overflow-hidden rounded-xl outline outline-1"
>
  <div
    class="group/header text-auto relative isolate flex items-center justify-between gap-1.5 truncate px-3 py-2.5"
  >
    <div class="inline-flex min-w-0 items-center gap-1 truncate">
      <Icon class="text-psx-icon self-center" name="pause" />

      <span class="flex min-w-0 items-baseline gap-1 truncate">
        <span class="shrink-0">{currentAgentName} wants to</span>
        <span class="shrink-0">{actionLabel}</span>
        {#if headerSubject}
          <span class="bg-psx-chrome truncate rounded-sm px-1 py-0.5 font-mono">
            {headerSubject}
          </span>
        {/if}
      </span>
    </div>
  </div>

  {#if command}
    <div
      class="border-psx-border text-psx-foreground-primary flex max-h-56 max-w-full flex-col overflow-auto overscroll-contain border-t"
      data-testid="acp-permission-command"
    >
      {#if description}
        <div class="text-psx-foreground-secondary px-2.5 pt-2 text-xs italic">
          {description}
        </div>
      {/if}
      <div class="font-(family-name:--editor-font-size) block min-h-4 px-2.5 py-2 text-sm">
        <pre class="whitespace-pre-wrap break-all"><span
            class="text-psx-foreground-secondary select-none"
            >$ </span><HighlightedShellCommand {command} /></pre>
      </div>
    </div>
  {:else if hasContent}
    <div
      class="border-psx-border flex max-h-56 flex-col gap-2 overflow-auto overscroll-contain border-t"
    >
      {#each displayToolCall.content ?? [] as content, i (`${content.type}-${i}`)}
        <ToolCallContentRenderer {content} />
      {/each}
    </div>
  {:else if rawInput}
    <div
      class="border-psx-border font-(family-name:--editor-font-size) block max-h-56 min-h-4 overflow-auto overscroll-contain border-t px-2.5 py-2 text-sm"
    >
      <pre class="whitespace-pre-wrap break-all">{rawInput}</pre>
    </div>
  {/if}

  <div bind:this={containerDiv} class="border-psx-border flex flex-col gap-1.5 border-t p-2">
    {#each request.options as option}
      {#if option.kind === "allow_always" && suggestedRules.length > 0}
        <div class="flex items-stretch gap-px">
          <Button
            aria-label={showAllSubCommandsButton
              ? "Auto-allow all sub-commands"
              : "Auto-allow action"}
            onclick={() => selectOption(option.optionId)}
            disabled={isSubmitting}
            class={[
              "flex-1 justify-start text-start",
              suggestedRuleAlternatives.length > 0 && "rounded-r-none",
            ]}
          >
            {#if showAllSubCommandsButton}
              <span>Always allow all commands used here</span>
            {:else}
              <span>
                Always Allow
                {#each suggestedRules as suggestion, i}
                  <span class="rounded-xs bg-black/5 px-1 py-0.5 align-middle font-mono text-xs"
                    >{suggestion}</span
                  >{#if i < suggestedRules.length - 1}{", "}{/if}
                {/each}
              </span>
            {/if}
          </Button>
          {#if suggestedRuleAlternatives.length > 0}
            {#if nativeMenus}
              <button
                type="button"
                bind:this={alternativesTriggerButton}
                aria-label="Pick a broader allow rule"
                data-testid="always-allow-alternatives-trigger"
                aria-haspopup="menu"
                aria-expanded={nativeAlternativesOpen}
                disabled={isSubmitting}
                onclick={() => openAlternativesNativeMenu(option.optionId)}
                class={alternativesTriggerClass}
              >
                <Icon name="chevron" size={14} aria-hidden="true" />
              </button>
            {:else}
              <button
                type="button"
                use:melt={$alternativesTrigger}
                aria-label="Pick a broader allow rule"
                data-testid="always-allow-alternatives-trigger"
                disabled={isSubmitting}
                class={alternativesTriggerClass}
              >
                <Icon name="chevron" size={14} aria-hidden="true" />
              </button>
            {/if}
          {/if}
        </div>
        {#if !nativeMenus && $alternativesOpen && suggestedRuleAlternatives.length > 0}
          <div
            use:melt={$alternativesMenuEl}
            class="menu-surface z-50 w-[min(calc(100vw-2rem),320px)] overflow-hidden p-1"
          >
            <div
              class="text-psx-foreground-secondary px-2 py-1 text-[11px] uppercase tracking-wide"
            >
              Instead, always allow
            </div>
            {#each suggestedRuleAlternatives as variant}
              <button
                type="button"
                onclick={() => selectOption(option.optionId, overrideRulesForVariant(variant))}
                disabled={isSubmitting}
                class="text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <span
                  class="rounded-xs truncate bg-black/5 px-1 py-0.5 align-middle font-mono text-xs"
                  >{variant}</span
                >
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        <Button
          aria-label={option.name}
          onclick={() => selectOption(option.optionId)}
          prominence={option.kind === "allow_once" ? "increased" : "standard"}
          disabled={isSubmitting}
          class="justify-between text-start"
        >
          <span>{optionLabel(option)}</span>
          {#if showKeyHints && allowShortcutOption && option.optionId === allowShortcutOption.optionId}
            <Kbd label={approveHint} />
          {:else if showKeyHints && denyShortcutOption && option.optionId === denyShortcutOption.optionId}
            <Kbd label={rejectHint} />
          {/if}
        </Button>
      {/if}
    {/each}
  </div>
</div>
