<script lang="ts">
  import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
  import { mount, unmount, untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import Icon from "@camber/components/icon";
  import { fuzzyScore } from "@camber/components/assistant-ui";
  import { LOCAL_AGENT_SERVER } from "../../../../agentServers";
  import { getACPChatSessionScope } from "../../../../features/ChatSessionScope.svelte";
  import { getACPAgentRegistryRepo } from "../../../../features/AgentRegistryRepository.svelte";
  import { getACPAgentServersRepo } from "../../../../features/AgentServersRepository.svelte";
  import { getACPHandoffConfirmation } from "../../../../features/HandoffConfirmationContext";
  import { getLocalInferenceRepo } from "../../../../features/LocalInferenceRepository.svelte";
  import { getACPSessionRepo } from "../../../../features/SessionRepository.svelte";
  import { appState, resolveSessionCwd } from "../../../../hostAdapter";
  import {
    formatLastPrompt,
    formatMemoryBytes,
    isExternalLocalInferenceRuntime,
    localRuntimeResidency,
  } from "../../../../localInferenceRuntime";
  import { localInferenceModelMissing } from "../../../../localInferenceModelOptions";
  import { pointerHeadedToRect, type Point } from "../../../../shared/safeTriangle";
  import { Spinner } from "@camber/components/spinner";
  import { supportsNativeMenus } from "../../desktopContextMenu";
  import type { NativeMenuIcon } from "../../nativeMenuIcons";
  import { presentNativeMenu, type MenuSpecItem } from "../../../ui/menuSpec";
  import MobileSelectSheet, { type MobileSelectOption } from "../../../ui/MobileSelectSheet.svelte";
  import RegistryAgentIcon from "../../../RegistryAgentIcon.svelte";
  import "../../desktopEmptyStateControl.css";
  import { isAgentPickerOptionId } from "../menus";
  import Tooltip from "../../../ui/Tooltip.svelte";
  import { resolveCssColorToHex } from "../../nativeMenuTheme";
  import {
    agentBrandTint,
    agentName,
    agentPickerIconProps,
    agentPickerIconUrl,
    agentPickerOverlayIconUrl,
    agentServerOptions,
    isClaudeAgent,
    selectedAgentServer,
    shouldResetSessionForAgentSelection,
  } from "./agentConfig";
  import DefaultStarButton from "./DefaultStarButton.svelte";
  import EffortBarsIcon from "./EffortBarsIcon.svelte";
  import {
    booleanCurrentValue,
    configIcon,
    effortBars,
    effortValueName,
    fastToggleState,
    optionGroups,
    orderClaudeModelValues,
    promptConfigKind,
    selectedValueName,
    shouldPersistConfigSelection,
    valueDescription,
  } from "./configOptions";
  import { Badge } from "@camber/components/badge";

  interface Props {
    // Collapsed away by the footer overflow manager when there is not even room
    // for the consolidated trigger.
    hiddenCount?: number;
    underlineLabel?: boolean;
    placement?: "top" | "bottom";
    /** Larger label sizing for the desktop centered new-conversation empty state. */
    emptyStateDesktop?: boolean;
  }

  let {
    hiddenCount = 0,
    underlineLabel = false,
    placement = "top",
    emptyStateDesktop = false,
  }: Props = $props();

  const chatSession = getACPChatSessionScope();
  const registry = getACPAgentRegistryRepo();
  const agentServers = getACPAgentServersRepo();
  const handoffConfirmation = getACPHandoffConfirmation();
  const repo = getACPSessionRepo();

  type SubmenuKind = "agent" | "model" | "fast" | "effort";
  // Extras (agent-supplied options without a dedicated slot) open under a
  // per-option key so any number of them can each own a submenu beside the
  // fixed four.
  type SubmenuKey = SubmenuKind | `extra:${string}`;

  function find(kind: "model" | "effort" | "fast"): SessionConfigOption | undefined {
    return chatSession.configOptions.find((option) => promptConfigKind(option) === kind);
  }

  const canChangeAgent = $derived(chatSession.canChangeAgent);
  const currentAgent = $derived(selectedAgentServer(chatSession));
  const serverName = $derived(agentName(registry, currentAgent));

  // --- local-agent warm/cold model indicator ---------------------------------
  // The local runtime context is provided app-wide by Repositories (every ACP
  // host constructs one), but that wiring lives outside this component's
  // reach; fall back to "no indicator" rather than crash if some future host
  // ever renders the prompt config controls without it.
  function optionalLocalInferenceRepo(): ReturnType<typeof getLocalInferenceRepo> | null {
    try {
      return getLocalInferenceRepo();
    } catch {
      return null;
    }
  }
  const localInference = optionalLocalInferenceRepo();

  const isLocalAgent = $derived(currentAgent === LOCAL_AGENT_SERVER);

  // Picking the local agent for a new conversation rescans the models
  // directory: a model placed there outside the app's download flow is only
  // discovered by a helper state read, so without this it stays missing from
  // the model picker until settings is opened or the app restarts. untrack
  // keeps the refresh from re-triggering itself when the new state lands.
  $effect(() => {
    if (!localInference || !isLocalAgent || chatSession.hasSession) return;
    void untrack(() => localInference.refreshIfStale());
  });

  // With no downloaded model the merge drops the model option entirely, so
  // nothing model-shaped would render; this puts a "No model available" note
  // where the model list belongs instead (the composer is locked on the same
  // condition, and this note is where it points).
  const localModelMissing = $derived(
    isLocalAgent && !!localInference && localInferenceModelMissing(localInference.state),
  );

  const showLocalModelWarmth = $derived(
    isLocalAgent && !!localInference && !isExternalLocalInferenceRuntime(localInference.state),
  );
  // Only meaningful for the local agent: which model (if any) is currently
  // resident in the sidecar's memory, so its next prompt skips the load.
  const localResidency = $derived(
    showLocalModelWarmth && localInference ? localRuntimeResidency(localInference.state) : null,
  );

  // loadedModelId and the catalog option values both come from the same
  // catalog and are normally identical strings; the last-path-segment
  // fallback tolerates an owner/name vs. bare-name mismatch between the two.
  function localModelValueIsResident(value: string): boolean {
    if (!localResidency) return false;
    if (value === localResidency.modelId) return true;
    return value.split("/").at(-1) === localResidency.modelId.split("/").at(-1);
  }

  function currentSelectValue(option: SessionConfigOption): string | undefined {
    return option.type === "select" ? option.currentValue : undefined;
  }

  const availableAgents = $derived(agentServerOptions(repo));
  const showAgentOption = $derived(
    availableAgents.length > 1 && (canChangeAgent || chatSession.hasSession),
  );
  const model = $derived(find("model"));
  const fast = $derived(find("fast"));
  const effort = $derived(find("effort"));
  // Claude's models render in the canonical family order everywhere they list
  // (inline menu, submenu, mobile sheet); other agents keep their given order.
  const claudeModelOrder = $derived(isClaudeAgent(registry, currentAgent));
  const modelValues = $derived.by(() => {
    if (!model) return [];
    const values = optionGroups(model).flatMap((g) => g.options);
    return claudeModelOrder ? orderClaudeModelValues(values) : values;
  });
  // With a small model list (fifteen or fewer) the models render inline in the
  // main menu instead of behind a submenu (no search box).
  const inlineModels = $derived(
    Boolean(model) && modelValues.length > 0 && modelValues.length <= 15,
  );

  const fastLabel = $derived.by(() => {
    if (!fast) return "";
    if (fast.type === "boolean") return booleanCurrentValue(fast) ? "On" : "Off";
    return selectedValueName(fast);
  });
  // Closed-state indicators on the trigger, so the two settings buried in the
  // submenus read at a glance: fast mode as a bolt (nothing when off, since
  // off is the quiet default) and the effort level as trailing subtext.
  const fastOn = $derived(fast ? fastToggleState(fast).isOn : false);
  const effortLabel = $derived(effort ? effortValueName(effort) : "");
  const effortBarsInfo = $derived(effort ? effortBars(effort) : null);
  // Effort submenu ordering: the auto/default entry first, then magnitudes
  // ascending — regardless of the order the agent lists them in.
  const sortedEffortValues = $derived.by<SessionConfigSelectOption[]>(() => {
    if (!effort) return [];
    const values = optionGroups(effort).flatMap((group) => group.options);
    if (!effortBarsInfo) return values;
    const byValue = new Map(values.map((value) => [value.value, value]));
    const ordered: SessionConfigSelectOption[] = [];
    if (effortBarsInfo.auto) {
      const auto = byValue.get(effortBarsInfo.auto.value);
      if (auto) ordered.push({ ...auto, name: effortBarsInfo.auto.name });
    }
    for (const level of effortBarsInfo.levels) {
      const value = byValue.get(level.value);
      if (value) ordered.push({ ...value, name: level.name });
    }
    return ordered;
  });
  // --- extras: agent-supplied options without a dedicated slot ---------------
  // Every select/boolean config option the picker doesn't already surface:
  // unclassified options (Claude's persona picker, Goose's provider,
  // temperature-style model_config entries) and surplus options of handled
  // kinds — the bound first-matches above are excluded by identity, not kind,
  // so a second model-shaped select still gets UI here. Mode-shaped options
  // belong to the ModeControl, and the synthetic agent-server picker is
  // guarded against defensively (session config should never contain it).
  // ACP defines the array order as the agent's preferred priority, so the
  // agent's relative order is preserved.
  const extraOptions = $derived.by<SessionConfigOption[]>(() =>
    chatSession.configOptions.filter((option) => {
      if (option.type !== "select" && option.type !== "boolean") return false;
      if (isAgentPickerOptionId(option.id)) return false;
      if (option === model || option === fast || option === effort) return false;
      const kind = promptConfigKind(option);
      return kind !== "mode" && kind !== "collaboration";
    }),
  );

  // One shared shape drives all three surfaces (native menu, DOM panel,
  // mobile sheets) so their ordering and labels can never drift apart.
  type ExtraValueRow = {
    id: string; // native action id: opt:<optionId>:<value>
    value: string; // wire value ("true"/"false" for booleans)
    label: string;
    sublabel?: string;
    checked: boolean;
  };
  type ExtraSection = { name?: string; rows: ExtraValueRow[] };
  // Extras carry no icon on any surface: their generic glyphs said nothing,
  // so openers and value rows are text-only. The OPENERS still align with
  // their icon-bearing siblings (Model/Fast Mode/Effort) via a reserved icon
  // slot — the native menu's explicit reserveIconSlot flag, the DOM panel's
  // placeholder box, the mobile sheet's own icon-column rule — while value
  // rows stay flush-left like the model rows.
  type ExtraEntry = {
    option: SessionConfigOption;
    key: `extra:${string}`; // DOM submenu / mobile sheet key (no value suffix)
    label: string;
    detail: string;
    sections: ExtraSection[];
  };

  function extraActionId(option: SessionConfigOption, value: string): string {
    return `opt:${option.id}:${value}`;
  }

  function toExtraEntry(option: SessionConfigOption): ExtraEntry {
    const key: ExtraEntry["key"] = `extra:${option.id}`;
    if (option.type === "boolean") {
      const current = booleanCurrentValue(option);
      return {
        option,
        key,
        label: option.name,
        detail: current ? "On" : "Off",
        // Mirrors the boolean Fast Mode submenu: two rows, On before Off.
        sections: [
          {
            rows: [true, false].map((choice) => ({
              id: extraActionId(option, String(choice)),
              value: String(choice),
              label: choice ? "On" : "Off",
              checked: current === choice,
            })),
          },
        ],
      };
    }
    return {
      option,
      key,
      label: option.name,
      detail: selectedValueName(option),
      // The agent's groups and value order, as given; named groups become
      // labeled sections like the model submenu's.
      sections: optionGroups(option)
        .map((group) => ({
          name: group.name,
          rows: group.options.map((value) => ({
            id: extraActionId(option, value.value),
            value: value.value,
            label: value.name,
            sublabel: valueDescription(value) ?? undefined,
            checked: option.type === "select" && value.value === option.currentValue,
          })),
        }))
        .filter((section) => section.rows.length > 0),
    };
  }

  const extraEntries = $derived(extraOptions.map(toExtraEntry));

  // While the agent's config probe is in flight there are no options to show
  // yet: surface that as an explicit loading state instead of a bare menu.
  // (Session-level probe runs when switching to an agent with no cached
  // config — first use can take several seconds while the agent downloads.)
  const configLoading = $derived(chatSession.isConfigCacheLoading);
  // The probe finished without options because the agent wants login first
  // (its config only becomes available once authenticated).
  const optionsNeedAuth = $derived(
    !configLoading &&
      !model &&
      !fast &&
      !effort &&
      extraOptions.length === 0 &&
      repo.agents.authRequiredForAgent(chatSession.activeAgentServer),
  );
  // Keep the control available when another agent can take over, even if the
  // current agent did not publish model or effort options — and while loading
  // or awaiting login, so the empty-state header always has a live picker.
  // Same for the local agent with no model: the menu carries the "No model
  // available" note the locked composer points to, so it must stay reachable
  // even in a local-agent-only install with nothing else to show.
  const hasOptions = $derived(
    Boolean(
      showAgentOption ||
        model ||
        fast ||
        effort ||
        extraOptions.length > 0 ||
        configLoading ||
        optionsNeedAuth ||
        localModelMissing,
    ),
  );

  // --- mobile bottom sheets ---------------------------------------------------
  // On the phone the anchored panel + side-by-side submenu don't fit (two
  // panels as wide as the whole ~390px viewport) and hover-driven rows don't
  // map to touch. The same structure renders as the standard bottom sheets
  // instead: a main sheet of option rows, each drilling into a value sheet.
  const isMobile = $derived($appState.environment.assistantHost === "mobile");
  // The phone footer shares one row with the mode control, mic, and submit:
  // there is room for the trigger's bolt but not for a word or two of effort.
  const showEffortLabel = $derived(Boolean(effortLabel) && !isMobile);
  const triggerButtonClass = $derived(
    emptyStateDesktop
      ? "desktop-empty-state-control focus:outline-psx-focus focus-visible:outline-2 active:outline-0"
      : "text-psx-foreground-primary hover:bg-psx-chrome-hover focus:outline-psx-focus flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm transition-colors focus-visible:outline-2 active:outline-0",
  );
  let mobileSheet = $state<"main" | SubmenuKey | null>(null);

  const mobileMainOptions = $derived.by<MobileSelectOption[]>(() => {
    const rows: MobileSelectOption[] = [];
    if (showAgentOption) {
      rows.push({
        id: "agent",
        label: "Agent",
        agentIcon: {
          iconUrl: agentPickerIconUrl(registry, currentAgent),
          ...agentPickerIconProps(registry, currentAgent),
        },
        detail: serverName,
        submenu: true,
      });
    }
    if (model) {
      rows.push({
        id: "model",
        label: "Model",
        icon: configIcon(model),
        detail: selectedValueName(model),
        submenu: true,
      });
    } else if (localModelMissing) {
      // Mirrors the desktop panel's note; the locked composer points here.
      rows.push({
        id: "no-local-model",
        label: "No model available",
        disabled: true,
      });
    }
    if (fast) {
      rows.push({
        id: "fast",
        label: "Fast Mode",
        icon: configIcon(fast),
        detail: fastLabel,
        submenu: true,
      });
    }
    if (effort) {
      rows.push({
        id: "effort",
        label: "Effort",
        icon: configIcon(effort),
        detail: effortValueName(effort),
        submenu: true,
      });
    }
    for (const entry of extraEntries) {
      // No icon: the sheet reserves the icon box itself when icon-bearing
      // rows (Model/Fast Mode/Effort) sit alongside, keeping labels aligned.
      rows.push({
        id: entry.key,
        label: entry.label,
        detail: entry.detail,
        submenu: true,
      });
    }
    // Mirror the desktop panel's status rows so the sheet is never empty (and
    // never silent) while options load or await login.
    if (configLoading) {
      rows.push({
        id: "config-loading",
        label: `Loading ${serverName} options...`,
        disabled: true,
      });
    } else if (optionsNeedAuth) {
      rows.push({
        id: "config-needs-auth",
        label: `Log in to ${serverName} to load its models and options.`,
        disabled: true,
      });
    }
    return rows;
  });

  function isSubmenuKind(id: string): id is SubmenuKind {
    return id === "agent" || id === "model" || id === "fast" || id === "effort";
  }

  function isSubmenuKey(id: string): id is SubmenuKey {
    return isSubmenuKind(id) || id.startsWith("extra:");
  }

  // The extras entry a mobile value sheet is showing, resolved from the
  // sheet's per-option key.
  const mobileExtraEntry = $derived(
    typeof mobileSheet === "string" && mobileSheet.startsWith("extra:")
      ? extraEntries.find((entry) => entry.key === mobileSheet)
      : undefined,
  );

  function extraSheetOptions(entry: ExtraEntry): MobileSelectOption[] {
    // De-dupe by value so a value appearing in more than one group keys once.
    const seen = new Set<string>();
    return entry.sections
      .flatMap((section) => section.rows)
      .filter((row) => (seen.has(row.value) ? false : (seen.add(row.value), true)))
      .map((row) => ({
        id: row.value,
        label: row.label,
        caption: row.sublabel,
        selected: row.checked,
      }));
  }

  function valueSheetOptions(
    option: SessionConfigOption,
    values: SessionConfigSelectOption[],
  ): MobileSelectOption[] {
    // De-dupe by value so a value appearing in more than one group keys once.
    const seen = new Set<string>();
    return values
      .filter((value) => (seen.has(value.value) ? false : (seen.add(value.value), true)))
      .map((value) => ({
        id: value.value,
        label: value.name,
        caption: valueDescription(value) ?? undefined,
        icon: configIcon(option),
        selected: option.type === "select" && value.value === option.currentValue,
      }));
  }

  // --- open/close state -----------------------------------------------------

  // Wide enough for a value's name and its description underneath (agents
  // describe their models and modes in a short sentence) without the subtext
  // clamping after a couple of words.
  const PANEL_W = 390;
  const SUB_W = 390;
  // Breathing room between popups and the window edges.
  const EDGE = 16;
  // Submenus tuck slightly under the main panel's facing edge.
  const SUB_OVERLAP = 4;

  let open = $state(false);
  let activeSub = $state<SubmenuKey | null>(null);
  let triggerEl = $state<HTMLButtonElement>();
  let panelEl = $state<HTMLDivElement>();
  let subEl = $state<HTMLDivElement>();
  let searchInputEl = $state<HTMLInputElement>();
  let panelStyle = $state("");
  let subStyle = $state("");
  let searchQuery = $state("");

  function toggleOpen(): void {
    if (open) {
      closeAll();
      return;
    }
    open = true;
    activeSub = null;
    searchQuery = "";
    positionPanel();
  }

  function closeAll(): void {
    cancelGrace();
    open = false;
    activeSub = null;
    searchQuery = "";
  }

  // Close everything if the trigger disappears while the menu is open — the
  // options vanished (agent restart, config error) or the footer overflow
  // manager collapsed the control — so the panel never floats unanchored.
  $effect(() => {
    if ((open || mobileSheet !== null) && (!hasOptions || hiddenCount > 0)) {
      closeAll();
      mobileSheet = null;
    }
  });

  // Hovering a main-menu row that doesn't own a submenu collapses whichever
  // submenu is open (matching how the opener rows switch between submenus).
  function closeSub(): void {
    if (!activeSub) return;
    activeSub = null;
    searchQuery = "";
    panelEl?.focus({ preventScroll: true });
  }

  function positionPanel(): void {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    // Right-align to the trigger, but never push the fixed-width panel's left
    // edge off-screen when the trigger sits far to the left.
    const maxRight = window.innerWidth - EDGE - PANEL_W;
    const right = Math.max(8, Math.min(window.innerWidth - rect.right, maxRight));
    const verticalPosition =
      placement === "bottom"
        ? `top: ${rect.bottom + 6}px`
        : `bottom: ${window.innerHeight - rect.top + 6}px`;
    // Clamp to the space between the trigger and the window edge the panel
    // grows toward, so a long inline model list scrolls instead of overflowing
    // the viewport.
    const maxHeight = Math.max(
      0,
      placement === "bottom" ? window.innerHeight - rect.bottom - 6 - EDGE : rect.top - 6 - EDGE,
    );
    panelStyle = `position: fixed; right: ${right}px; ${verticalPosition}; width: ${PANEL_W}px; max-height: ${maxHeight}px; overflow-y: auto; z-index: 50;`;
  }

  let subAnchorTop = 0;

  function openSub(kind: SubmenuKey, row: HTMLElement): void {
    cancelGrace();
    if (activeSub === kind) return;
    activeSub = kind;
    searchQuery = "";
    if (!panelEl) return;
    subAnchorTop = row.getBoundingClientRect().top;
    const panelRect = panelEl.getBoundingClientRect();
    // Prefer the right side of the main menu, overlapping it slightly so the
    // panels read as one surface; flip to the left when the viewport has no
    // room there.
    let left = panelRect.right - SUB_OVERLAP;
    if (left + SUB_W > window.innerWidth - EDGE) {
      left = panelRect.left - SUB_W + SUB_OVERLAP;
    }
    left = Math.max(EDGE, left);
    subStyle = `position: fixed; left: ${left}px; top: ${subAnchorTop}px; width: ${SUB_W}px; z-index: 51;`;
  }

  // Once the submenu's real height is known, align it with its row and pull it
  // back up only as far as the viewport requires.
  $effect(() => {
    if (!activeSub || !subEl) return;
    const height = subEl.getBoundingClientRect().height;
    const top = Math.max(EDGE, Math.min(subAnchorTop, window.innerHeight - EDGE - height));
    subEl.style.top = `${top}px`;
  });

  // Focus the panel container so keystrokes leave the prompt editor, then let
  // key routing (below) steer characters into the submenu search box.
  $effect(() => {
    if (!open || !panelEl) return;
    panelEl.focus({ preventScroll: true });
  });

  $effect(() => {
    if (!activeSub || !searchInputEl) return;
    searchInputEl.focus({ preventScroll: true });
  });

  function handleWindowPointerdown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target as Node;
    if (panelEl?.contains(target) || subEl?.contains(target) || triggerEl?.contains(target)) {
      return;
    }
    closeAll();
  }

  // --- submenu hover grace ----------------------------------------------------
  // Travelling from an opener row to its open submenu crosses other rows (the
  // path is diagonal), and a bare mouseenter
  // there would instantly switch or close the submenu. Hovers are therefore
  // ignored while the pointer sits inside the triangle between its last
  // position and the submenu's facing edge (padded, so slightly overshooting
  // the submenu doesn't dismiss it either). A pointer that lingers on a row
  // still wins: the suppressed hover runs after a short delay if the row is
  // still hovered — this guards travel, it is not a dead zone.
  const SUB_GRACE_PAD = 16;
  const SUB_GRACE_MS = 300;

  let lastPointer: Point | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleWindowMousemove(event: MouseEvent): void {
    if (!open) return;
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  function cancelGrace(): void {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }

  // lastPointer trails the event by one mousemove (mouseenter fires between
  // moves), so it serves as the triangle's apex behind the pointer's heading.
  function pointerHeadedToSub(event: MouseEvent): boolean {
    if (!activeSub || !subEl || !lastPointer) return false;
    return pointerHeadedToRect(
      { x: event.clientX, y: event.clientY },
      lastPointer,
      subEl.getBoundingClientRect(),
      SUB_GRACE_PAD,
    );
  }

  function hoverWithGrace(event: MouseEvent, action: () => void): void {
    cancelGrace();
    if (!pointerHeadedToSub(event)) {
      action();
      return;
    }
    const row = event.currentTarget as HTMLElement;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (row.matches(":hover")) action();
    }, SUB_GRACE_MS);
  }

  // Arrow keys walk the rows of the active panel (the submenu when one is
  // open): Down from the search box highlights the first row, then Up/Down
  // move through the list — matching the empty-state dropdowns.
  function moveFocus(delta: number): void {
    const container = activeSub ? subEl : panelEl;
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.max(0, Math.min(items.length - 1, index + delta));
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: "nearest" });
  }

  // While the menu is open, typed characters belong to the submenu search box —
  // never the prompt input. Escape peels one layer at a time.
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (activeSub) {
        activeSub = null;
        searchQuery = "";
        panelEl?.focus({ preventScroll: true });
      } else {
        closeAll();
        triggerEl?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (!searchInputEl || event.target === searchInputEl) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Backspace") {
      searchQuery = searchQuery.slice(0, -1);
      searchInputEl.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key.length !== 1) return;
    searchQuery += event.key;
    searchInputEl.focus();
    event.preventDefault();
    event.stopPropagation();
  }

  // The menu renders inside the prompt <form>, so Enter in the search box would
  // natively submit it (reloading the webview). Intercept it and activate the
  // first matching row instead.
  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const items = subEl?.querySelectorAll<HTMLElement>('[role="menuitem"]');
      if (items && items.length > 0) items[0].click();
      return;
    }
    if (event.key === "Escape") return; // handled by the window handler
    event.stopPropagation();
  }

  // --- selection handlers ----------------------------------------------------

  function canSelectAgent(agentServer: string): boolean {
    return (
      !shouldResetSessionForAgentSelection(chatSession, agentServer) ||
      canChangeAgent ||
      chatSession.canHandoff
    );
  }

  function agentSelectionLabel(agentServer: string): string {
    const name = agentName(registry, agentServer);
    return chatSession.hasSession && shouldResetSessionForAgentSelection(chatSession, agentServer)
      ? `${name} (handoff)`
      : name;
  }

  function selectAgent(agentServer: string): void {
    closeAll();
    mobileSheet = null;
    if (!shouldResetSessionForAgentSelection(chatSession, agentServer)) return;
    if (chatSession.hasSession || chatSession.hasPendingHandoff) {
      if (chatSession.hasSession && !chatSession.canHandoff) return;
      const conversationId = chatSession.conversationId;
      if (!conversationId) return;
      // Not remembered yet: the handoff still needs confirming, and
      // acceptance records it (HandoffConfirmationProvider).
      handoffConfirmation.request({ conversationId, targetAgentServer: agentServer });
      return;
    }
    rememberLastUsedAgent(agentServer);
    chatSession.createSession(
      chatSession.pendingSessionCwd ?? resolveSessionCwd($appState),
      agentServer,
      chatSession.pendingConversationId,
    );
  }

  async function selectConfigValue(option: SessionConfigOption, value: string): Promise<void> {
    closeAll();
    try {
      await chatSession.setConfigOption(option.id, value);
    } catch (error) {
      console.error("Failed to set ACP session config option", error);
    }
  }

  async function selectBoolean(option: SessionConfigOption, value: boolean): Promise<void> {
    closeAll();
    try {
      await chatSession.setBooleanConfigOption(option.id, value);
    } catch (error) {
      console.error("Failed to set ACP session config option", error);
    }
  }

  // Shared dispatch for an extras row: the exact same calls the dedicated
  // rows make, with the boolean rows' "true"/"false" strings mapped back.
  function selectExtraValue(option: SessionConfigOption, value: string): void {
    if (option.type === "boolean") void selectBoolean(option, value === "true");
    else void selectConfigValue(option, value);
  }

  // An explicit agent pick becomes the remembered agent for the next new
  // conversation. Fire-and-forget: persistence must never block or break the
  // selection itself. Same-value writes are skipped, and a pinned default
  // agent is never followed — the pin fixes the default deliberately.
  function rememberLastUsedAgent(agentServer: string): void {
    if (repo.agents.defaultAgentServerPinned) return;
    if (agentServer === repo.agents.defaultAgentServer) return;
    void agentServers.setDefaultAgentServer(agentServer).catch((error: unknown) => {
      console.error("Failed to remember last-used ACP agent", error);
    });
  }

  // --- pinned defaults (the star buttons) -------------------------------------
  // A pressed star means PINNED: the key's default is fixed to that value and
  // the last-used auto-follow leaves it alone. Clicking an unpressed star pins
  // the row's value; clicking the pressed star unpins (the value stays, it
  // just resumes following last use). Applies to select rows only — boolean
  // rows carry no star.

  function isPinnedDefault(option: SessionConfigOption, value: string): boolean {
    const agentServer = chatSession.activeAgentServer;
    return (
      repo.agents.isPinnedConfigOption(agentServer, option.id) &&
      repo.agents.defaultConfigOptionsFor(agentServer)[option.id] === value
    );
  }

  async function setPinnedConfig(
    option: SessionConfigOption,
    value: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      if (pinned) {
        await repo.agents.setPinnedDefaultConfigOption(
          chatSession.activeAgentServer,
          option.id,
          value,
        );
      } else {
        await repo.agents.unpinDefaultConfigOption(chatSession.activeAgentServer, option.id, {
          // Follow-managed options (model/effort/fast and the other
          // persistable categories) keep their value on unpin — the
          // last-used auto-follow overwrites it. For anything else (extras
          // with unknown semantics) the follow never writes the key, yet
          // applyDefaultConfigOptions would keep seeding every new session
          // with it — an invisible default with no UI left to clear — so the
          // unpin removes the stored value too.
          clearValue: !shouldPersistConfigSelection(option),
        });
      }
    } catch (error) {
      console.error("Failed to update pinned ACP config option", error);
    }
  }

  function isPinnedDefaultAgent(agentServer: string): boolean {
    return repo.agents.defaultAgentServerPinned && agentServer === repo.agents.defaultAgentServer;
  }

  async function setPinnedAgent(agentServer: string, pinned: boolean): Promise<void> {
    try {
      if (pinned) await agentServers.setPinnedDefaultAgentServer(agentServer);
      else await agentServers.unpinDefaultAgentServer();
    } catch (error) {
      console.error("Failed to update pinned default ACP agent", error);
    }
  }

  // --- search ----------------------------------------------------------------

  // Filter and rank by fuzzy match quality: prefix/substring hits before
  // scattered-letter subsequence hits, so the best match sits at the top,
  // where Enter selects.
  function rankBySearch<T>(items: T[], label: (item: T) => string): T[] {
    const query = searchQuery.trim();
    if (!query) return items;
    return items
      .map((item) => ({ item, score: fuzzyScore(query, label(item)) }))
      .filter((entry): entry is { item: T; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }

  const activeSubOption = $derived.by<SessionConfigOption | undefined>(() => {
    if (activeSub === "model") return model;
    if (activeSub === "fast") return fast;
    if (activeSub === "effort") return effort;
    return undefined;
  });

  const activeExtraEntry = $derived(
    activeSub?.startsWith("extra:")
      ? extraEntries.find((entry) => entry.key === activeSub)
      : undefined,
  );

  const subSearchable = $derived.by(() => {
    if (activeSub === "agent") return agentServerOptions(repo).length > 5;
    if (activeSubOption && activeSubOption.type === "select") {
      return optionGroups(activeSubOption).flatMap((g) => g.options).length > 5;
    }
    return false;
  });

  function filteredValues(values: SessionConfigSelectOption[]): SessionConfigSelectOption[] {
    return rankBySearch(values, (value) => value.name);
  }

  // With no search, model lists surface the selected entry at the top (their
  // order carries no meaning, unlike mode or effort lists). Claude is the
  // exception: its family order is meaningful, so it holds even for the
  // selected model.
  function orderedValues(
    option: SessionConfigOption,
    values: SessionConfigSelectOption[],
  ): SessionConfigSelectOption[] {
    const ranked = filteredValues(values);
    if (searchQuery.trim() || option.type !== "select" || promptConfigKind(option) !== "model") {
      return ranked;
    }
    if (claudeModelOrder) return orderClaudeModelValues(ranked);
    const index = ranked.findIndex((value) => value.value === option.currentValue);
    if (index <= 0) return ranked;
    return [ranked[index], ...ranked.slice(0, index), ...ranked.slice(index + 1)];
  }

  // --- native menu (macOS desktop) --------------------------------------------
  // The desktop app on macOS presents this menu as a real OS menu built from
  // the same deriveds the DOM panel renders from. The spec is a snapshot taken
  // at open time — a native menu cannot re-render while up, so an in-flight
  // config probe surfaces as a disabled Loading item instead of updating in
  // place, and the submenu search box is dropped (macOS type-select covers it).
  const nativeMenus = $derived(supportsNativeMenus($appState.environment));
  let nativeOpen = $state(false);

  function nativeAgentIcon(agentServer: string): NativeMenuIcon {
    const url = agentPickerIconUrl(registry, agentServer);
    // Same masked-URL icon RegistryAgentIcon renders, with its fallback glyph
    // and the same brand tint the DOM rows apply through agentPickerIconProps
    // (Camber's vibrant, Claude's orange); untinted agents keep the default
    // glyph color, as in the DOM. The local agent's badge overlay (the
    // computer glyph sitting in the roundel's notch) composites in too.
    if (!url) return "sparkles";
    const overlayUrl = agentPickerOverlayIconUrl(agentServer);
    const color = resolveCssColorToHex(agentBrandTint(registry, agentServer));
    return color !== undefined ? { url, color, overlayUrl } : { url, overlayUrl };
  }

  // The native counterpart of EffortBarsIcon is the component itself: render
  // it off-DOM with the same props the DOM rows use and hand the serialized
  // markup to the icon rasterizer (its bars fill with currentColor, so the
  // rasterizer's default glyph color applies, as in the DOM).
  function effortBarsMenuIcon(total: number, filled: number): NativeMenuIcon | undefined {
    const container = document.createElement("div");
    try {
      const component = mount(EffortBarsIcon, { target: container, props: { total, filled } });
      try {
        const svg = container.querySelector("svg");
        return svg ? { svg: new XMLSerializer().serializeToString(svg) } : undefined;
      } finally {
        void unmount(component);
      }
    } catch {
      return undefined;
    } finally {
      container.remove();
    }
  }

  // The DOM warmth dot's tooltip text; the native row carries it as toolTip
  // only (the DOM shows no textual warmth state, so the sublabel stays the
  // agent's own description).
  function nativeWarmthToolTip(value: string): string | undefined {
    if (!showLocalModelWarmth) return undefined;
    if (localModelValueIsResident(value) && localResidency) {
      const memoryLabel = formatMemoryBytes(localResidency.memoryBytes);
      const lastPromptLabel = formatLastPrompt(localResidency.lastActivityUnixMs, Date.now());
      return `Loaded in memory${memoryLabel ? ` (${memoryLabel})` : ""}${
        lastPromptLabel ? ` · last prompt ${lastPromptLabel}` : ""
      }`;
    }
    return "Not loaded — first prompt loads the model";
  }

  // One native action per selectable value, mirroring valueRow: the value's
  // name with the agent's description underneath, a SELECTED pill on the
  // active value, and category-prefixed ids routing back to the DOM handlers.
  // Icons follow valueRow's leading element: none for model rows (the warmth
  // dot becomes toolTip), the wand for an effort auto/default entry, and the
  // rasterized EffortBarsIcon for effort magnitudes. The default-star
  // accessory renders natively as a star row (valueRow always renders the
  // star, so every value row carries one), filled on the pinned default
  // value.
  function nativeValueAction(
    option: SessionConfigOption,
    value: SessionConfigSelectOption,
  ): MenuSpecItem {
    const kind = promptConfigKind(option) ?? "config";
    const bars = kind === "effort" ? effortBars(option) : null;
    const barLevel = bars?.levels.find((level) => level.value === value.value);
    // Model names stand on their own, and an unrecognized effort range renders
    // as given — both row kinds carry no leading element in the DOM either.
    const icon: NativeMenuIcon | undefined = bars
      ? barLevel
        ? effortBarsMenuIcon(bars.total, barLevel.filled)
        : "wand"
      : kind === "model" || kind === "effort"
        ? undefined
        : configIcon(option);
    return {
      kind: "action",
      id: `${kind}:${value.value}`,
      label: value.name,
      sublabel: valueDescription(value) ?? undefined,
      icon,
      checked:
        option.type === "select" && value.value === (bars?.activeValue ?? option.currentValue),
      toolTip: kind === "model" ? nativeWarmthToolTip(value.value) : undefined,
      star: { starred: isPinnedDefault(option, value.value) },
      // One radio group per option: starring a value clears only its
      // siblings' stars, never another option's pinned row. The opt: prefix
      // namespaces agent-supplied option ids away from the built-in groups
      // (an option literally named "agent-server" must not clear the agent
      // rows' stars).
      starGroup: `opt:${option.id}`,
    };
  }

  // Mirrors the selectSubmenu snippet: named groups become section headers,
  // further unnamed groups get a plain separator.
  function nativeSelectItems(option: SessionConfigOption): MenuSpecItem[] {
    const items: MenuSpecItem[] = [];
    optionGroups(option).forEach((group, groupIndex) => {
      const visible = orderedValues(option, group.options);
      if (visible.length === 0) return;
      if (group.name) items.push({ kind: "separator", label: group.name });
      else if (groupIndex > 0) items.push({ kind: "separator" });
      for (const value of visible) items.push(nativeValueAction(option, value));
    });
    return items;
  }

  function nativeAgentItems(): MenuSpecItem[] {
    // The DOM agent rows carry the default star too, filled when the app-wide
    // default agent is pinned to this row.
    return availableAgents.map((server) => ({
      kind: "action",
      id: `agent:${server}`,
      label: agentSelectionLabel(server),
      icon: nativeAgentIcon(server),
      checked: server === currentAgent,
      enabled: canSelectAgent(server),
      star: { starred: isPinnedDefaultAgent(server) },
      // The agent rows form their own radio group, apart from every config
      // option's group. Config-option groups carry an opt: prefix, so an
      // agent-supplied option whose id is literally "agent" (Claude's
      // persona picker) can never collide with this built-in group.
      starGroup: "agent-server",
    }));
  }

  function nativeFastItems(option: SessionConfigOption): MenuSpecItem[] {
    if (option.type === "boolean") {
      return [true, false].map((choice) => ({
        kind: "action",
        id: `fast:${String(choice)}`,
        label: choice ? "On" : "Off",
        icon: configIcon(option),
        checked: booleanCurrentValue(option) === choice,
      }));
    }
    return nativeSelectItems(option);
  }

  function nativeEffortItems(option: SessionConfigOption): MenuSpecItem[] {
    // Auto/default first, then magnitudes ascending — as in the DOM submenu.
    if (effortBarsInfo) {
      return sortedEffortValues.map((value) => nativeValueAction(option, value));
    }
    return nativeSelectItems(option);
  }

  // Extras render from the shared entry shape: named groups become section
  // headers like the model submenu's, and boolean extras mirror the Fast Mode
  // On/Off pair. Rows carry opt:-prefixed ids (see extraSelectionForId) and,
  // like model rows, no icon. Select-shaped extras carry the default star —
  // explicit pinning is deliberate, so it is allowed even for options the
  // last-used auto-follow ignores; boolean rows stay star-less as everywhere.
  function nativeExtraItems(entry: ExtraEntry): MenuSpecItem[] {
    const items: MenuSpecItem[] = [];
    const starrable = entry.option.type === "select";
    entry.sections.forEach((section, sectionIndex) => {
      if (section.name) items.push({ kind: "separator", label: section.name });
      else if (sectionIndex > 0) items.push({ kind: "separator" });
      for (const row of section.rows) {
        items.push({
          kind: "action",
          id: row.id,
          label: row.label,
          sublabel: row.sublabel,
          checked: row.checked,
          ...(starrable
            ? {
                star: { starred: isPinnedDefault(entry.option, row.value) },
                // Same one-group-per-option rule (and opt: namespacing) as
                // nativeValueAction.
                starGroup: `opt:${entry.option.id}`,
              }
            : {}),
        });
      }
    });
    return items;
  }

  // The native top level mirrors the DOM panel's first-level rows in order:
  // rows that open the side panel become submenus with the same contents
  // (each carrying the DOM row's dimmed current-selection text as `detail`),
  // the inline model list stays inline, and the loading / auth /
  // no-local-model notes become disabled items (the DOM prose has no action
  // to trigger). Every submenu carries the DOM sub-panel's fixed width as its
  // own `minWidth`, so long value descriptions (e.g. an agent's persona
  // sublabels) wrap to two lines at the sub-panel's width instead of
  // stretching the native submenu to fit one line.
  function nativeMenuItems(): MenuSpecItem[] {
    const items: MenuSpecItem[] = [];
    if (showAgentOption) {
      items.push({
        kind: "submenu",
        label: "Agent",
        detail: serverName,
        icon: nativeAgentIcon(currentAgent),
        minWidth: SUB_W,
        items: nativeAgentItems(),
      });
    }
    if (configLoading) {
      if (showAgentOption) items.push({ kind: "separator" });
      items.push({
        kind: "action",
        id: "status:loading",
        label: `Loading ${serverName} options...`,
        sublabel:
          "Getting available models and settings from the agent. The first launch can take a few seconds while the agent starts up.",
        enabled: false,
      });
    } else if (optionsNeedAuth) {
      if (showAgentOption) items.push({ kind: "separator" });
      items.push({
        kind: "action",
        id: "status:needs-auth",
        label: `Log in to ${serverName} to load its models and options.`,
        enabled: false,
      });
    }
    if (model && inlineModels) {
      // The header separator names whose models are listed once the Agent row
      // is hidden, standing in for modelsHeader.
      if (showAgentOption) items.push({ kind: "separator" });
      else items.push({ kind: "separator", label: `${serverName} models` });
      for (const value of modelValues) items.push(nativeValueAction(model, value));
      if (fast || effort) items.push({ kind: "separator" });
    } else if (model) {
      const modelItems: MenuSpecItem[] = [];
      if (!showAgentOption) {
        modelItems.push({ kind: "separator", label: `${serverName} models` });
      }
      modelItems.push(...nativeSelectItems(model));
      items.push({
        kind: "submenu",
        label: "Model",
        detail: selectedValueName(model),
        icon: configIcon(model),
        minWidth: SUB_W,
        items: modelItems,
      });
    } else if (localModelMissing) {
      // Where the model list belongs; the locked composer points here.
      if (showAgentOption) items.push({ kind: "separator" });
      else items.push({ kind: "separator", label: `${serverName} models` });
      items.push({
        kind: "action",
        id: "status:no-local-model",
        label: "No model available",
        enabled: false,
      });
    }
    if (fast) {
      items.push({
        kind: "submenu",
        label: "Fast Mode",
        detail: fastLabel,
        icon: configIcon(fast),
        minWidth: SUB_W,
        items: nativeFastItems(fast),
      });
    }
    if (effort) {
      items.push({
        kind: "submenu",
        label: "Effort",
        detail: effortValueName(effort),
        // The DOM opener shows the wand for the auto/default state (and for an
        // unrecognized effort range, whose configIcon is also the wand); an
        // active bar level renders the real EffortBarsIcon, rasterized.
        icon: effortBarsInfo
          ? effortBarsInfo.isAuto
            ? "wand"
            : effortBarsMenuIcon(effortBarsInfo.total, effortBarsInfo.activeFilled ?? 0)
          : configIcon(effort),
        minWidth: SUB_W,
        items: nativeEffortItems(effort),
      });
    }
    if (extraEntries.length > 0) {
      // A plain separator sets the agent's own extra options apart from the
      // dedicated rows — skipped when they are the only content.
      if (items.length > 0) items.push({ kind: "separator" });
      for (const entry of extraEntries) {
        // No icon, but the icon slot is reserved so these labels align with
        // the icon-bearing Fast Mode/Effort openers — the native counterpart
        // of the DOM opener's empty placeholder box. Explicitly per row: the
        // inline model rows at this same level stay flush-left by not
        // setting the flag.
        items.push({
          kind: "submenu",
          label: entry.label,
          detail: entry.detail,
          reserveIconSlot: true,
          minWidth: SUB_W,
          items: nativeExtraItems(entry),
        });
      }
    }
    return items;
  }

  // Extras route through `opt:<optionId>:<value>` ids. Option ids and values
  // may themselves contain ":", so instead of splitting blindly the id is
  // matched against the known extras (longest option id first, in case one id
  // prefixes another) and the value keeps everything after the option id's
  // own separator — a value like "openai:gpt-5" round-trips intact. Among
  // nested-id candidates, one whose value actually exists wins.
  function extraSelectionForId(
    rest: string,
  ): { option: SessionConfigOption; value: string } | undefined {
    const candidates = extraOptions
      .filter((option) => rest.startsWith(`${option.id}:`))
      .map((option) => ({ option, value: rest.slice(option.id.length + 1) }))
      .sort((a, b) => b.option.id.length - a.option.id.length);
    return (
      candidates.find(({ option, value }) =>
        option.type === "boolean"
          ? value === "true" || value === "false"
          : optionGroups(option).some((group) =>
              group.options.some((candidate) => candidate.value === value),
            ),
      ) ?? candidates[0]
    );
  }

  // Category-prefixed ids route each selection to the exact handler the
  // matching DOM row calls.
  function handleNativeSelect(id: string): void {
    if (id.startsWith("agent:")) {
      selectAgent(id.slice("agent:".length));
    } else if (id.startsWith("model:") && model) {
      void selectConfigValue(model, id.slice("model:".length));
    } else if (id.startsWith("fast:") && fast) {
      const value = id.slice("fast:".length);
      if (fast.type === "boolean") void selectBoolean(fast, value === "true");
      else void selectConfigValue(fast, value);
    } else if (id.startsWith("effort:") && effort) {
      void selectConfigValue(effort, id.slice("effort:".length));
    } else if (id.startsWith("opt:")) {
      const selection = extraSelectionForId(id.slice("opt:".length));
      if (selection) selectExtraValue(selection.option, selection.value);
    }
  }

  // Star clicks route to the same pin handlers the matching DOM row's
  // DefaultStarButton calls: `starred` is the row's NEW state, so true pins
  // the row's value and false unpins its option.
  function handleNativeSetDefault(id: string, starred: boolean): void {
    if (id.startsWith("agent:")) {
      void setPinnedAgent(id.slice("agent:".length), starred);
    } else if (id.startsWith("model:") && model) {
      void setPinnedConfig(model, id.slice("model:".length), starred);
    } else if (id.startsWith("fast:") && fast && fast.type !== "boolean") {
      void setPinnedConfig(fast, id.slice("fast:".length), starred);
    } else if (id.startsWith("effort:") && effort) {
      void setPinnedConfig(effort, id.slice("effort:".length), starred);
    } else if (id.startsWith("opt:")) {
      const selection = extraSelectionForId(id.slice("opt:".length));
      if (selection && selection.option.type === "select") {
        void setPinnedConfig(selection.option, selection.value, starred);
      }
    }
  }

  // The OS positions the menu itself: anchored just under the trigger and
  // right-aligned to it like the DOM panel, flipping near screen edges on its
  // own.
  async function openNativeMenu(): Promise<void> {
    if (nativeOpen || !triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    nativeOpen = true;
    try {
      const id = await presentNativeMenu(
        nativeMenuItems(),
        {
          x: rect.right,
          y: rect.bottom + 4,
          align: "end",
        },
        // The DOM panel's fixed width: with a minWidth the native menu wraps
        // sublabels at it, instead of growing to the longest sublabel (the
        // loading note alone would stretch it to ~700pt).
        { highlightStyle: "themed", minWidth: PANEL_W, onSetDefault: handleNativeSetDefault },
      );
      if (id !== undefined) handleNativeSelect(id);
    } finally {
      nativeOpen = false;
    }
  }

  // No text size: rows inherit the menu surface's 13px system font.
  const itemBaseClass =
    "group flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-psx-foreground-primary outline-hidden hover:bg-psx-menu-hover-background focus:bg-psx-menu-hover-background";
  const itemClass = `${itemBaseClass} items-center`;
  // Two-line rows anchor their icon, star, and badge to the name, not to the
  // middle of the row: a description hanging below must not drag them down.
  const itemTopAlignedClass = `${itemBaseClass} items-start`;
  // Summary rows (Agent/Model/Fast Mode/Effort) pair a full-size label with a
  // smaller, dimmed value further along the same row. Centering two different
  // line-heights leaves them a pixel or two off each other's baseline — latent
  // everywhere, but only visible with some UI fonts, which is why it showed up
  // in the VS host and not VS Code or desktop. Label and value are grouped
  // into their own baseline-aligned, justify-between box (see labelValueClass
  // below) rather than putting items-baseline on the row itself, which would
  // resize the row to fit the text's baseline and throw off the icon/chevron
  // centered against it. flex-1 (not ml-auto) so the box itself stretches to
  // fill the row — ml-auto would just shove the whole label+value pair flush
  // right as one unit, taking the label away from the icon with it.
  const labelValueClass = "flex min-w-0 flex-1 items-baseline justify-between gap-2";

  // The panels render position:fixed, but inside the chat pane they are
  // trapped in its stacking context, so surfaces later in the DOM (the bottom
  // panel, other splits) paint over them. Portal them to <body> so the
  // viewport coordinates keep working and the z-index wins globally.
  function portalToBody(): Attachment {
    return (element: Element) => {
      document.body.appendChild(element);
      return () => {
        element.remove();
      };
    };
  }

  // Value and agent rows render as role=menuitem divs (a button cannot
  // contain another button, and the rows host nested interactive accessories
  // like the star and the warmth-dot tooltip); Enter/Space activate them like
  // a button would — only when the row itself is focused, so the same keys
  // bubbling up from the nested star button keep activating the star.
  function rowKeydown(event: KeyboardEvent, activate: () => void): void {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  }
</script>

<svelte:window
  onpointerdowncapture={handleWindowPointerdown}
  onkeydowncapture={handleWindowKeydown}
  onmousemovecapture={handleWindowMousemove}
/>

{#snippet localModelWarmthDot(value: string)}
  {@const warm = localModelValueIsResident(value)}
  <Tooltip placement="top" gutter={6} openDelay={400}>
    {#snippet label()}
      {#if warm && localResidency}
        {@const memoryLabel = formatMemoryBytes(localResidency.memoryBytes)}
        {@const lastPromptLabel = formatLastPrompt(localResidency.lastActivityUnixMs, Date.now())}
        <span>
          Loaded in memory{memoryLabel ? ` (${memoryLabel})` : ""}{lastPromptLabel
            ? ` · last prompt ${lastPromptLabel}`
            : ""}
        </span>
      {:else}
        <span>Not loaded — first prompt loads the model</span>
      {/if}
    {/snippet}
    <span
      class={[
        "size-1.5 shrink-0 rounded-full",
        warm ? "bg-emerald-500" : "border-psx-foreground-tertiary border",
      ]}
      aria-hidden="true"
    ></span>
  </Tooltip>
{/snippet}

{#snippet valueRow(
  option: SessionConfigOption,
  value: SessionConfigSelectOption,
  withStar: boolean,
  inMainMenu: boolean = false,
)}
  {@const activate = () => void selectConfigValue(option, value.value)}
  {@const kind = promptConfigKind(option)}
  {@const bars = kind === "effort" ? effortBars(option) : null}
  {@const description = valueDescription(value)}
  <div
    role="menuitem"
    tabindex="0"
    class={description ? itemTopAlignedClass : itemClass}
    onclick={activate}
    onkeydown={(event) => rowKeydown(event, activate)}
    onmouseenter={inMainMenu ? (event) => hoverWithGrace(event, closeSub) : undefined}
  >
    {#if bars || (kind === "model" && showLocalModelWarmth) || (kind !== "model" && kind !== "effort")}
      <!-- Sized to one line of the name (the menu's own line box) so the
           glyph centres on the first line rather than on the whole, possibly
           two-line, row. Model names stand on their own, and an unrecognized
           effort range renders as given, so those rows carry no leading element
           at all — not an empty one, which would indent them by the row gap. -->
      <span
        class={["flex shrink-0 items-center", description && "h-[var(--text-menu--line-height)]"]}
      >
        {#if bars}
          {@const level = bars.levels.find((candidate) => candidate.value === value.value)}
          {#if level}
            <EffortBarsIcon total={bars.total} filled={level.filled} />
          {:else}
            <!-- Not a magnitude: the agent's default/auto entry. -->
            <Icon name="wand" size={16} class="shrink-0" aria-hidden="true" />
          {/if}
        {:else if kind === "model"}
          {@render localModelWarmthDot(value.value)}
        {:else}
          <Icon name={configIcon(option)} size={16} class="shrink-0" aria-hidden="true" />
        {/if}
      </span>
    {/if}
    <!-- The agent's own words for this value, under its name. Wrapped to two
         lines at most so one verbose entry cannot dominate the list. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="truncate">{value.name}</span>
      {#if description}
        <span class="text-psx-foreground-tertiary line-clamp-2 text-xs leading-snug">
          {description}
        </span>
      {/if}
    </div>
    <span
      class={[
        "ml-auto flex shrink-0 items-center gap-1",
        description && "h-[var(--text-menu--line-height)]",
      ]}
    >
      {#if withStar}
        {@const pinned = isPinnedDefault(option, value.value)}
        <DefaultStarButton
          label="Use {value.name} by default"
          pressed={pinned}
          onPress={() => void setPinnedConfig(option, value.value, !pinned)}
        />
      {/if}
      {#if option.type === "select" && value.value === (bars?.activeValue ?? option.currentValue)}
        <Badge size="xs" class="uppercase">Selected</Badge>
      {/if}
    </span>
  </div>
{/snippet}

{#snippet modelsHeader()}
  <!-- Mid conversation the agent is fixed; this small title names whose models
       are listed, standing in for the Agent row. -->
  <div class="text-psx-foreground-tertiary flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs">
    <RegistryAgentIcon
      iconUrl={agentPickerIconUrl(registry, currentAgent)}
      fallback="sparkles"
      size={13}
      {...agentPickerIconProps(registry, currentAgent)}
    />
    <span class="truncate">{serverName} models</span>
  </div>
{/snippet}

{#snippet selectSubmenu(option: SessionConfigOption)}
  {#each optionGroups(option) as group, groupIndex (group.name ?? `_${groupIndex}`)}
    {@const visible = orderedValues(option, group.options)}
    {#if visible.length > 0}
      {#if group.name}
        <div class="text-psx-foreground-tertiary px-2 pb-0.5 pt-1.5 text-xs">{group.name}</div>
      {:else if groupIndex > 0}
        <div class="menu-separator"></div>
      {/if}
      {#each visible as value (value.value)}
        {@render valueRow(option, value, true)}
      {/each}
    {/if}
  {/each}
{/snippet}

<!-- Extras submenu, rendered from the same shared entry the native menu and
     mobile sheets use so ordering and labels stay identical across the three
     surfaces. Rows follow valueRow's layout — name with the agent's
     description underneath, star on select rows, Selected badge on the
     current value — and, like model rows, carry no leading element at all
     (not an empty one, which would indent the whole list by the row gap). -->
{#snippet extraSubmenu(entry: ExtraEntry)}
  {#each entry.sections as section, sectionIndex (section.name ?? `_${sectionIndex}`)}
    {#if section.name}
      <div class="text-psx-foreground-tertiary px-2 pb-0.5 pt-1.5 text-xs">{section.name}</div>
    {:else if sectionIndex > 0}
      <div class="menu-separator"></div>
    {/if}
    {#each section.rows as row (row.id)}
      {@const activate = () => selectExtraValue(entry.option, row.value)}
      {@const pinnable = entry.option.type === "select"}
      {@const pinned = pinnable && isPinnedDefault(entry.option, row.value)}
      <div
        role="menuitem"
        tabindex="0"
        class={row.sublabel ? itemTopAlignedClass : itemClass}
        onclick={activate}
        onkeydown={(event) => rowKeydown(event, activate)}
      >
        <div class="flex min-w-0 flex-1 flex-col text-left">
          <span class="truncate">{row.label}</span>
          {#if row.sublabel}
            <span class="text-psx-foreground-tertiary line-clamp-2 text-xs leading-snug">
              {row.sublabel}
            </span>
          {/if}
        </div>
        <span
          class={[
            "ml-auto flex shrink-0 items-center gap-1",
            row.sublabel && "h-[var(--text-menu--line-height)]",
          ]}
        >
          {#if pinnable}
            <DefaultStarButton
              label="Use {row.label} by default"
              pressed={pinned}
              onPress={() => void setPinnedConfig(entry.option, row.value, !pinned)}
            />
          {/if}
          {#if row.checked}
            <Badge size="xs" class="uppercase">Selected</Badge>
          {/if}
        </span>
      </div>
    {/each}
  {/each}
{/snippet}

{#if hiddenCount === 0 && hasOptions}
  <div class={emptyStateDesktop ? "desktop-empty-state-control-wrap" : "contents"}>
    <button
      type="button"
      bind:this={triggerEl}
      onclick={() => {
        if (isMobile) {
          mobileSheet = "main";
        } else if (nativeMenus) {
          void openNativeMenu();
        } else {
          toggleOpen();
        }
      }}
      aria-label="Agent, model and options"
      aria-haspopup="menu"
      aria-expanded={open || nativeOpen || mobileSheet !== null}
      class={[
        triggerButtonClass,
        (open || nativeOpen || mobileSheet !== null) &&
          !emptyStateDesktop &&
          "bg-psx-chrome-hover text-psx-foreground-primary",
      ]}
    >
      <RegistryAgentIcon
        iconUrl={agentPickerIconUrl(registry, currentAgent)}
        fallback="sparkles"
        size={14}
        {...agentPickerIconProps(registry, currentAgent)}
      />
      <!-- Model name and effort text sit at different sizes; grouping them in
           their own baseline-aligned box, separate from the icon/chevron
           around it, aligns the two without disturbing that icon/chevron —
           items-baseline on the outer row instead would size the row to fit
           the text's baseline and throw off every icon centered against it. -->
      <span class="flex min-w-0 items-baseline gap-1">
        {#if model}
          <span
            class={[
              "truncate",
              // The effort text and bolt claim room the model name used to have,
              // so its cap tightens when they are present rather than letting the
              // trigger grow — a wider trigger collides with the compose actions
              // sooner and the footer overflow manager drops the whole control.
              isMobile ? "max-w-[8rem]" : showEffortLabel ? "max-w-[10rem]" : "max-w-[12rem]",
              underlineLabel &&
                !emptyStateDesktop &&
                "underline decoration-dotted underline-offset-2",
            ]}
          >
            {selectedValueName(model)}
          </span>
        {:else}
          <span
            class={[
              "truncate",
              isMobile ? "max-w-[8rem]" : "max-w-[9rem]",
              underlineLabel &&
                !emptyStateDesktop &&
                "underline decoration-dotted underline-offset-2",
            ]}
          >
            {serverName}
          </span>
        {/if}
        {#if fastOn}
          <Icon
            name="bolt"
            size={emptyStateDesktop ? 15 : 12}
            class="text-psx-icon shrink-0 self-center"
            aria-hidden="true"
          />
        {/if}
        {#if showEffortLabel}
          <span
            class={[
              "text-psx-foreground-tertiary shrink-0 truncate",
              emptyStateDesktop ? "text-sm" : "text-xs",
            ]}
          >
            {effortLabel}
          </span>
        {/if}
      </span>
      {#if configLoading}
        <Spinner size={12} class="opacity-60" aria-label="Loading agent options" />
      {/if}
      <Icon name="chevron" size={12} class="shrink-0 opacity-60" aria-hidden="true" />
    </button>
  </div>
{/if}

{#if isMobile && mobileSheet === "main"}
  <MobileSelectSheet
    title="Session options"
    options={mobileMainOptions}
    onSelect={(id) => {
      if (isSubmenuKey(id)) mobileSheet = id;
    }}
    onClose={() => (mobileSheet = null)}
  />
{:else if isMobile && mobileSheet === "agent"}
  <MobileSelectSheet
    title="Agent"
    options={availableAgents.map((server) => ({
      id: server,
      label: agentSelectionLabel(server),
      agentIcon: {
        iconUrl: agentPickerIconUrl(registry, server),
        ...agentPickerIconProps(registry, server),
      },
      selected: server === currentAgent,
      disabled: !canSelectAgent(server),
    }))}
    onSelect={(server) => selectAgent(server)}
    onClose={() => (mobileSheet = null)}
  />
{:else if isMobile && mobileSheet === "model" && model}
  <MobileSelectSheet
    title="Model"
    options={valueSheetOptions(model, modelValues)}
    onSelect={(value) => void selectConfigValue(model, value)}
    onClose={() => (mobileSheet = null)}
  />
{:else if isMobile && mobileSheet === "fast" && fast}
  {#if fast.type === "boolean"}
    <MobileSelectSheet
      title="Fast Mode"
      options={[true, false].map((choice) => ({
        id: String(choice),
        label: choice ? "On" : "Off",
        icon: configIcon(fast),
        selected: booleanCurrentValue(fast) === choice,
      }))}
      onSelect={(value) => void selectBoolean(fast, value === "true")}
      onClose={() => (mobileSheet = null)}
    />
  {:else}
    <MobileSelectSheet
      title="Fast Mode"
      options={valueSheetOptions(
        fast,
        optionGroups(fast).flatMap((group) => group.options),
      )}
      onSelect={(value) => void selectConfigValue(fast, value)}
      onClose={() => (mobileSheet = null)}
    />
  {/if}
{:else if isMobile && mobileSheet === "effort" && effort}
  <MobileSelectSheet
    title="Effort"
    options={valueSheetOptions(effort, sortedEffortValues)}
    onSelect={(value) => void selectConfigValue(effort, value)}
    onClose={() => (mobileSheet = null)}
  />
{:else if isMobile && mobileExtraEntry}
  <MobileSelectSheet
    title={mobileExtraEntry.label}
    options={extraSheetOptions(mobileExtraEntry)}
    onSelect={(value) => selectExtraValue(mobileExtraEntry.option, value)}
    onClose={() => (mobileSheet = null)}
  />
{/if}

{#if open}
  <div
    bind:this={panelEl}
    {@attach portalToBody()}
    tabindex="-1"
    role="menu"
    aria-label="Agent, model and options"
    data-placement={placement}
    style={panelStyle}
    class="menu-surface p-1"
  >
    {#if showAgentOption}
      <button
        type="button"
        role="menuitem"
        class={itemClass}
        onclick={(event) => openSub("agent", event.currentTarget)}
        onmouseenter={(event) => {
          const row = event.currentTarget;
          hoverWithGrace(event, () => openSub("agent", row));
        }}
      >
        <RegistryAgentIcon
          iconUrl={agentPickerIconUrl(registry, currentAgent)}
          fallback="sparkles"
          size={16}
          {...agentPickerIconProps(registry, currentAgent)}
        />
        <span class={labelValueClass}>
          <span class="shrink-0">Agent</span>
          <span class="text-psx-foreground-tertiary min-w-0 truncate text-xs">{serverName}</span>
        </span>
        <Icon
          name="chevron"
          size={12}
          weight={1.5}
          class="text-psx-icon shrink-0 -rotate-90"
          aria-hidden="true"
        />
      </button>
    {/if}

    {#if configLoading}
      {#if showAgentOption}
        <div class="menu-separator"></div>
      {/if}
      <div
        role="status"
        class="text-psx-foreground-secondary flex items-center gap-2 px-2 pb-0.5 pt-1.5"
        data-testid="prompt-config-loading"
      >
        <!-- The wrapper is the live region; the spinner (which carries its own
             role="status") stays decorative so the state announces once. -->
        <Spinner size={14} aria-hidden="true" />
        <span class="truncate">Loading {serverName} options...</span>
      </div>
      <p class="text-psx-foreground-tertiary px-2 pb-1.5 pt-0.5 text-xs">
        Getting available models and settings from the agent. The first launch can take a few
        seconds while the agent starts up.
      </p>
    {:else if optionsNeedAuth}
      {#if showAgentOption}
        <div class="menu-separator"></div>
      {/if}
      <p
        class="text-psx-foreground-tertiary px-2 py-1.5 text-xs"
        data-testid="prompt-config-needs-auth"
      >
        Log in to {serverName} to load its models and options.
      </p>
    {/if}

    {#if model && inlineModels}
      <!-- Inline model list: labelled mid-conversation, and separated from
           option rows above and below (never from its own title). -->
      {#if showAgentOption}
        <div class="menu-separator"></div>
      {:else}
        {@render modelsHeader()}
      {/if}
      {#each modelValues as value (value.value)}
        {@render valueRow(model, value, true, true)}
      {/each}
      {#if fast || effort}
        <div class="menu-separator"></div>
      {/if}
    {:else if model}
      <button
        type="button"
        role="menuitem"
        class={itemClass}
        onclick={(event) => openSub("model", event.currentTarget)}
        onmouseenter={(event) => {
          const row = event.currentTarget;
          hoverWithGrace(event, () => openSub("model", row));
        }}
      >
        <Icon name={configIcon(model)} size={16} class="shrink-0" aria-hidden="true" />
        <span class={labelValueClass}>
          <span class="shrink-0">Model</span>
          {#if showLocalModelWarmth}
            <!-- The dot has no text baseline of its own, so this can't join
                 the label/value baseline pairing the way the plain-text
                 branch below does — it keeps the old vertical centering. -->
            <span
              class="text-psx-foreground-tertiary flex min-w-0 items-center gap-1.5 self-center truncate text-xs"
            >
              {@render localModelWarmthDot(currentSelectValue(model) ?? "")}
              <span class="truncate">{selectedValueName(model)}</span>
            </span>
          {:else}
            <span class="text-psx-foreground-tertiary min-w-0 truncate text-xs">
              {selectedValueName(model)}
            </span>
          {/if}
        </span>
        <Icon
          name="chevron"
          size={12}
          weight={1.5}
          class="text-psx-icon shrink-0 -rotate-90"
          aria-hidden="true"
        />
      </button>
    {:else if localModelMissing}
      <!-- Where the model list belongs; the locked composer points here. -->
      {#if showAgentOption}
        <div class="menu-separator"></div>
      {:else}
        {@render modelsHeader()}
      {/if}
      <p
        class="text-psx-foreground-tertiary px-2 py-1.5 text-xs"
        data-testid="prompt-config-no-local-model"
      >
        No model available
      </p>
    {/if}

    {#if fast}
      <button
        type="button"
        role="menuitem"
        class={itemClass}
        onclick={(event) => openSub("fast", event.currentTarget)}
        onmouseenter={(event) => {
          const row = event.currentTarget;
          hoverWithGrace(event, () => openSub("fast", row));
        }}
      >
        <Icon name={configIcon(fast)} size={16} class="shrink-0" aria-hidden="true" />
        <span class={labelValueClass}>
          <span class="shrink-0">Fast Mode</span>
          <span class="text-psx-foreground-tertiary min-w-0 truncate text-xs">{fastLabel}</span>
        </span>
        <Icon
          name="chevron"
          size={12}
          weight={1.5}
          class="text-psx-icon shrink-0 -rotate-90"
          aria-hidden="true"
        />
      </button>
    {/if}

    {#if effort}
      <button
        type="button"
        role="menuitem"
        class={itemClass}
        onclick={(event) => openSub("effort", event.currentTarget)}
        onmouseenter={(event) => {
          const row = event.currentTarget;
          hoverWithGrace(event, () => openSub("effort", row));
        }}
      >
        {#if effortBarsInfo?.isAuto}
          <Icon name="wand" size={16} class="shrink-0" aria-hidden="true" />
        {:else if effortBarsInfo}
          <EffortBarsIcon total={effortBarsInfo.total} filled={effortBarsInfo.activeFilled ?? 0} />
        {:else}
          <Icon name={configIcon(effort)} size={16} class="shrink-0" aria-hidden="true" />
        {/if}
        <span class={labelValueClass}>
          <span class="shrink-0">Effort</span>
          <span class="text-psx-foreground-tertiary min-w-0 truncate text-xs">
            {effortValueName(effort)}
          </span>
        </span>
        <Icon
          name="chevron"
          size={12}
          weight={1.5}
          class="text-psx-icon shrink-0 -rotate-90"
          aria-hidden="true"
        />
      </button>
    {/if}

    {#if extraEntries.length > 0}
      <!-- The agent's own extra options, set apart from the dedicated rows —
           unless they are the only content. -->
      {#if showAgentOption || model || localModelMissing || fast || effort || configLoading || optionsNeedAuth}
        <div class="menu-separator"></div>
      {/if}
      {#each extraEntries as entry (entry.option.id)}
        <button
          type="button"
          role="menuitem"
          class={itemClass}
          onclick={(event) => openSub(entry.key, event.currentTarget)}
          onmouseenter={(event) => {
            const row = event.currentTarget;
            hoverWithGrace(event, () => openSub(entry.key, row));
          }}
        >
          <!-- Extras openers carry no icon, but sit alongside icon-bearing
               opener rows (Model/Fast Mode/Effort): an empty box the size of
               their icons keeps the labels aligned down the panel. -->
          <span class="size-4 shrink-0" aria-hidden="true"></span>
          <span class={labelValueClass}>
            <!-- Agent-supplied names can be long, so unlike the fixed rows the
                 label truncates too rather than pushing the value out. -->
            <span class="min-w-0 truncate">{entry.label}</span>
            <span class="text-psx-foreground-tertiary min-w-0 truncate text-xs">
              {entry.detail}
            </span>
          </span>
          <Icon
            name="chevron"
            size={12}
            weight={1.5}
            class="text-psx-icon shrink-0 -rotate-90"
            aria-hidden="true"
          />
        </button>
      {/each}
    {/if}
  </div>
{/if}

{#if open && activeSub}
  <div
    bind:this={subEl}
    {@attach portalToBody()}
    tabindex="-1"
    role="menu"
    aria-label={activeExtraEntry ? `${activeExtraEntry.label} options` : `${activeSub} options`}
    onmouseenter={cancelGrace}
    style={subStyle}
    class="menu-surface max-h-[320px] overflow-y-auto p-1"
  >
    <!-- No title for the fast/effort submenus: the row that opened them is
         right there, still naming them. The models submenu is the exception —
         its header names whose models these are, which nothing else says once
         the Agent row is hidden. -->
    {#if activeSub === "model" && !showAgentOption}
      {@render modelsHeader()}
    {/if}
    {#if subSearchable}
      <div class="px-0.5 pb-1 pt-0.5">
        <input
          bind:this={searchInputEl}
          type="text"
          bind:value={searchQuery}
          onkeydown={handleSearchKeydown}
          placeholder="Search..."
          aria-label="Search options"
          spellcheck="false"
          autocorrect="off"
          autocapitalize="off"
          autocomplete="off"
          class="border-psx-border bg-psx-editor-background text-psx-foreground-primary placeholder:text-psx-foreground-secondary/50 focus:border-psx-focus w-full rounded-md border px-2 py-1 text-sm outline-none"
        />
      </div>
    {/if}

    {#if activeSub === "agent"}
      {#each rankBySearch( availableAgents, (server) => agentName(registry, server), ) as server (server)}
        {@const selectable = canSelectAgent(server)}
        {@const pinned = isPinnedDefaultAgent(server)}
        <div
          role="menuitem"
          tabindex={selectable ? 0 : -1}
          aria-disabled={!selectable}
          class={[itemClass, !selectable && "cursor-not-allowed opacity-50"]}
          onclick={() => selectable && selectAgent(server)}
          onkeydown={(event) => selectable && rowKeydown(event, () => selectAgent(server))}
        >
          <RegistryAgentIcon
            iconUrl={agentPickerIconUrl(registry, server)}
            fallback="sparkles"
            size={16}
            {...agentPickerIconProps(registry, server)}
          />
          <span class="truncate">{agentSelectionLabel(server)}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1">
            <DefaultStarButton
              label="Use {agentName(registry, server)} by default"
              pressed={pinned}
              onPress={() => void setPinnedAgent(server, !pinned)}
            />
            {#if server === currentAgent}
              <Badge size="xs" class="uppercase">Selected</Badge>
            {/if}
          </span>
        </div>
      {/each}
    {:else if activeSub === "fast" && fast?.type === "boolean"}
      {#each [true, false] as choice (String(choice))}
        <button
          type="button"
          role="menuitem"
          class={itemClass}
          onclick={() => void selectBoolean(fast, choice)}
        >
          <Icon name={configIcon(fast)} size={16} class="shrink-0" aria-hidden="true" />
          <span class="truncate">{choice ? "On" : "Off"}</span>
          {#if booleanCurrentValue(fast) === choice}
            <Badge size="xs" class="ml-auto uppercase">Selected</Badge>
          {/if}
        </button>
      {/each}
    {:else if activeSub === "effort" && effort && effortBarsInfo}
      <!-- Auto/default first, then magnitudes ascending. -->
      {#each filteredValues(sortedEffortValues) as value (value.value)}
        {@render valueRow(effort, value, true)}
      {/each}
    {:else if activeExtraEntry}
      {@render extraSubmenu(activeExtraEntry)}
    {:else if activeSubOption}
      {@render selectSubmenu(activeSubOption)}
    {/if}
  </div>
{/if}
