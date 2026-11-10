<script module lang="ts">
  const draftPrompts = new Map<string, string>();
</script>

<script lang="ts">
  import type { ContentBlock } from "@agentclientprotocol/sdk";
  import { InfoMessageType } from "@camber/rpc";
  import Icon from "@camber/components/icon";
  import * as Prompt from "@camber/components/prompt";
  import { flushSync, onDestroy, onMount, type ComponentProps, type Snippet } from "svelte";
  import { getOptionalACPConnectionPoolContext } from "../../connectionPoolContext";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import { getACPConversationRepo } from "../../features/ConversationRepository.svelte";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { appState, resolveSessionCwd } from "../../hostAdapter";
  import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "../../agentServers";
  import { enableClaudeSessionFeatures } from "../../claudePromptSuggestions";
  import { getLocalInferenceRepo } from "../../features/LocalInferenceRepository.svelte";
  import { localInferenceModelMissing } from "../../localInferenceModelOptions";
  import { agentName as getAgentName, isClaudeAgent } from "./menus/config/agentConfig";
  import CommandMenu from "./menus/command/CommandMenu.svelte";
  import SkillsMenu from "./menus/command/SkillsMenu.svelte";
  import ConfigValueMenus from "./menus/config/ConfigValueMenus.svelte";
  import PromptConfigControls from "./menus/config/PromptConfigControls.svelte";
  import PlanModeIndicator from "./PlanModeIndicator.svelte";
  import GoalIndicator from "./GoalIndicator.svelte";
  import PromptModeControl from "./menus/config/PromptModeControl.svelte";
  import { AcpSlashCommand } from "./menus/command/commands";
  import {
    AGENT_CONFIG_OPTION_ID,
    AGENT_CONFIG_OPTION_LABEL,
    acpMenus,
    configMenuValue,
  } from "./menus/menus";
  import { saveACPConversationDump } from "../../dumpACPConversation";
  import { menus } from "../../prompt/menus/menus";
  import FilesMenu from "../../prompt/menus/files/FilesMenu.svelte";
  import SymbolsMenu from "../../prompt/menus/symbols/SymbolsMenu.svelte";
  import WebsitesMenu from "../../prompt/menus/websites/WebsitesMenu.svelte";
  import SecretsMenu from "../../prompt/menus/secrets/SecretsMenu.svelte";
  import SecretEditMenu from "../../prompt/menus/secrets/SecretEditMenu.svelte";
  import DesktopFilePromptChipInserter from "./DesktopFilePromptChipInserter.svelte";
  import PastedAttachments from "./PastedAttachments.svelte";
  import DictationWaveform from "./speech/DictationWaveform.svelte";
  import SpeechButton from "./speech/SpeechButton.svelte";
  import { voiceInputStore } from "./speech/voiceInputStore.svelte";
  import { buildACPPromptContent } from "./promptContent";
  import { normalizeDumpEntries } from "../../debugDump";
  import { scopeTrajectoryToConversation } from "../../trajectory";
  import { rpc } from "../../hostRpc";
  import { getContextRepoContext } from "../../../context";
  import { installedSkills } from "./menus/command/InstalledSkillsRepository.svelte";
  import { showDesktopContextMenu } from "./desktopContextMenu";
  import {
    buildPromptSubmitContextMenuItems,
    performPromptSubmitContextMenuAction,
    supportsNativePromptSubmitContextMenu,
  } from "./promptSubmitContextMenu";
  import { getKeybindingService, withShortcut } from "../../../keybindings";
  import ActivePromptSubmit from "./ActivePromptSubmit.svelte";

  interface Props extends ComponentProps<typeof Prompt.Root> {
    onConfigureAgents?: () => void;
    onInterrupt?: () => void;
    onNewConversation?: () => void | Promise<void>;
    onSubmit?: (value: string) => void;
    submitDisabled?: boolean;
    disabled?: boolean;
    draftKey?: string | null;
    promptBanners?: Snippet;
    promptCommandItems?: Snippet;
    promptMenus?: Snippet;
    footerLeading?: Snippet;
    desktopFilePromptChipTarget?: boolean;
    showConfigControls?: boolean;
    /** Focus the editor once it mounts (e.g. a freshly opened conversation). */
    autofocus?: boolean;
  }

  let {
    onConfigureAgents,
    onInterrupt,
    onNewConversation,
    onSubmit,
    submitDisabled = false,
    disabled = false,
    draftKey = null,
    promptBanners,
    promptCommandItems,
    promptMenus,
    footerLeading,
    desktopFilePromptChipTarget = true,
    showConfigControls = true,
    autofocus = false,
    ...rest
  }: Props = $props();

  // The editor mounts with this component (child-first), so it is ready by the
  // time this runs. iOS only reliably raises the keyboard from within a user
  // gesture, so on a phone this focuses the field but may not open the keyboard
  // until the field is tapped.
  onMount(() => {
    if (autofocus) prompt?.focus();
    void installedSkills.refresh();
  });

  const acpConnectionPool = getOptionalACPConnectionPoolContext();
  const chatSession = getACPChatSessionScope();
  const conversations = getACPConversationRepo();
  const contextRepo = getContextRepoContext();
  const registry = getACPAgentRegistryRepo();
  const keybindings = getKeybindingService();
  const isTurnActive = $derived(chatSession.isPrompting || chatSession.isRemoteWorking);
  const steerWithEnter = $derived(
    chatSession.canSteerPrompt && $appState.environment.desktopSteerWithEnter === true,
  );
  const currentAgentServer = $derived(
    chatSession.sessionAgentServer ?? chatSession.activeAgentServer ?? DEFAULT_AGENT_SERVER,
  );
  const currentAgentName = $derived(getAgentName(registry, currentAgentServer));
  // The local agent with no downloaded model has nothing to serve a prompt
  // with, so the composer locks rather than letting a send fail opaquely. The
  // config controls in the footer stay interactive — the user can still switch
  // agents or pick a model once one lands (the menu says "No model
  // available"), and the composer unlocks reactively when either happens. The
  // context is app-wide but optional; hosts without it never lock.
  function optionalLocalInferenceRepo(): ReturnType<typeof getLocalInferenceRepo> | null {
    try {
      return getLocalInferenceRepo();
    } catch {
      return null;
    }
  }
  const localInference = optionalLocalInferenceRepo();
  const localModelMissing = $derived(
    currentAgentServer === LOCAL_AGENT_SERVER &&
      !!localInference &&
      localInferenceModelMissing(localInference.state),
  );
  const resolvedDisabled = $derived(disabled || localModelMissing);
  const resolvedSubmitDisabled = $derived(
    Boolean(
      submitDisabled ||
        localModelMissing ||
        chatSession.isSessionSetupPending ||
        (chatSession.isPrompting && !chatSession.canEnqueuePrompt) ||
        // A turn started on another surface is running: sending would be
        // rejected by the helper (one turn per conversation), and the local
        // enqueue machinery can't flush after a turn it didn't start.
        chatSession.isRemoteWorking,
    ),
  );
  let prompt: Prompt.Root;
  let pastedAttachments = $state<
    | {
        contentBlocks: () => ContentBlock[];
        clear: () => void;
      }
    | undefined
  >();
  let activeSessionCwd = $derived(
    chatSession.sessionInfo?.cwd || chatSession.pendingSessionCwd || resolveSessionCwd($appState),
  );
  let promptValue = $state("");
  let hasPromptContent = $derived(promptValue.trim().length > 0);
  // The phone composer is a single-line pill (see mobile-remote app.css): the
  // field fills the row and the footer shrinks to the compose actions, leaving
  // no room for config controls there. They move to a slim accessory strip
  // above the pill instead.
  const isMobile = $derived($appState.environment.assistantHost === "mobile");
  const isDesktop = $derived($appState.environment.assistantHost === "desktop");

  $effect(() => {
    if (!isTurnActive || !onInterrupt) return;
    return keybindings?.register("interrupt", onInterrupt);
  });

  // Progressive overflow handling for the footer: when the leading (slash/mode)
  // and trailing (config + actions) clusters would collide, the consolidated
  // config trigger is hidden until they fit. Measured against actual geometry
  // rather than width breakpoints, so it adapts to any agent/model label length.
  // Mobile is exempt: its config controls live in the accessory strip.
  let leadingClusterEl = $state<HTMLElement>();
  let trailingClusterEl = $state<HTMLElement>();
  let configHiddenCount = $state(0);
  const MAX_CONFIG_HIDDEN = 1;
  const CLUSTER_MIN_GAP = 12;
  const DRAFT_SIDEBAR_PREVIEW_DEBOUNCE_MS = 1000;
  let draftSidebarPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDraftSidebarPreview:
    | {
        conversationId: string;
        value: string;
        updateTitle: boolean;
      }
    | undefined;

  function clustersOverlap(): boolean {
    if (!leadingClusterEl || !trailingClusterEl) return false;
    const leadingRight = leadingClusterEl.getBoundingClientRect().right;
    const trailingLeft = trailingClusterEl.getBoundingClientRect().left;
    return leadingRight + CLUSTER_MIN_GAP > trailingLeft;
  }

  function reflowFooter(): void {
    if (!leadingClusterEl || !trailingClusterEl) return;
    // Hide controls while the clusters would collide.
    while (configHiddenCount < MAX_CONFIG_HIDDEN && clustersOverlap()) {
      configHiddenCount += 1;
      flushSync();
    }
    // Reveal controls again while the next one still fits.
    while (configHiddenCount > 0) {
      configHiddenCount -= 1;
      flushSync();
      if (clustersOverlap()) {
        configHiddenCount += 1;
        flushSync();
        break;
      }
    }
  }

  $effect(() => {
    if (isMobile) return;
    const footer = leadingClusterEl?.parentElement;
    if (!footer) return;
    const observer = new ResizeObserver(() => reflowFooter());
    observer.observe(footer);
    return () => observer.disconnect();
  });

  // Re-fit when the control set or label widths change (agent/model/mode names,
  // the agent dropdown appearing on send) without a footer resize.
  $effect(() => {
    if (isMobile) return;
    void chatSession.configOptions;
    void chatSession.canChangeAgent;
    void currentAgentName;
    const frame = requestAnimationFrame(() => reflowFooter());
    return () => cancelAnimationFrame(frame);
  });

  async function sendPrompt(value: string, { sendNow = false } = {}): Promise<void> {
    if (chatSession.isSessionSetupPending) return;
    const content = promptContent(value);
    clearDraftSidebarPreview();
    const conversationId = chatSession.pendingConversationId ?? chatSession.conversationId;
    if (conversationId) {
      // Chats use the latest submitted user message as their sidebar label.
      // Apply it synchronously so a quick paste-and-send cannot skip the update.
      if (chatSession.isChat) {
        conversations.setDraftTitle(conversationId, value);
      }
      // The editor clears after submit starts, when isSending suppresses draft updates.
      conversations.setDraftPromptPresence(conversationId, false);
    }
    contextRepo.reset();
    pastedAttachments?.clear();
    onSubmit?.(value);
    if (chatSession.isPrompting) {
      if (sendNow && chatSession.canSteerPrompt) {
        await chatSession.steerPrompt(value, content);
        return;
      }
      chatSession.enqueuePrompt({
        text: value,
        content,
        cwd: activeSessionCwd,
      });
      if (sendNow) onInterrupt?.();
      return;
    }
    const newSessionMeta = isClaudeAgent(registry, currentAgentServer)
      ? enableClaudeSessionFeatures()
      : undefined;
    await chatSession.send(value, undefined, newSessionMeta, activeSessionCwd, content);
  }

  const submit: Prompt.PromptProps["onSubmit"] = async (value) => {
    if (handleTypedLocalCommand(value)) return;
    await sendPrompt(value, { sendNow: steerWithEnter });
  };

  const submitNow: Prompt.PromptProps["onSubmitNow"] = async (value) => {
    if (handleTypedLocalCommand(value)) return;
    await sendPrompt(value, { sendNow: !steerWithEnter });
  };

  function openPromptSubmitContextMenu(event: MouseEvent): void {
    if (!supportsNativePromptSubmitContextMenu($appState.environment)) return;
    event.preventDefault();
    event.stopPropagation();

    void showDesktopContextMenu(
      buildPromptSubmitContextMenuItems(chatSession.canSteerPrompt, steerWithEnter),
      {
        x: event.clientX,
        y: event.clientY,
      },
    ).then((actionId) =>
      performPromptSubmitContextMenuAction(actionId, {
        enqueue: () => (steerWithEnter ? prompt.submitNow() : prompt.submit()),
        sendNow: () => (steerWithEnter ? prompt.submit() : prompt.submitNow()),
      }),
    );
  }

  function handleCommand(command: AcpSlashCommand) {
    switch (command) {
      case AcpSlashCommand.new: {
        if (onNewConversation) {
          void onNewConversation();
          break;
        }
        const cwd = activeSessionCwd;
        chatSession.createSession(
          cwd,
          chatSession.activeAgentServer,
          chatSession.pendingConversationId,
        );
        break;
      }

      case AcpSlashCommand.dump: {
        void dumpActiveACPConversation();
        break;
      }

      case AcpSlashCommand.load: {
        void loadACPConversation();
        break;
      }

      case AcpSlashCommand.secrets: {
        pushPromptMenu(menus.secrets.value);
        break;
      }

      case AcpSlashCommand.plan: {
        void chatSession.togglePlanMode();
        break;
      }
    }
  }

  function handleTypedLocalCommand(value: string): boolean {
    const command = slashCommandName(value);
    if (command === AGENT_CONFIG_OPTION_LABEL) {
      return openAgentConfigMenu();
    }

    const matchingConfigOption = chatSession.configOptions.find((option) => option.id === command);

    if (matchingConfigOption) {
      if (matchingConfigOption.type === "boolean") {
        void chatSession.setBooleanConfigOption(
          matchingConfigOption.id,
          !matchingConfigOption.currentValue,
        );
        return true;
      }
      setTimeout(() => pushPromptMenu(configMenuValue(matchingConfigOption.id)), 0);
      return true;
    }

    switch (command) {
      case AcpSlashCommand.new:
        handleCommand(AcpSlashCommand.new);
        return true;
      case AcpSlashCommand.plan:
        handleCommand(AcpSlashCommand.plan);
        return true;
      case AcpSlashCommand.dump:
        handleCommand(AcpSlashCommand.dump);
        return true;
      case AcpSlashCommand.load:
        handleCommand(AcpSlashCommand.load);
        return true;
      case AcpSlashCommand.secrets:
        setTimeout(() => handleCommand(AcpSlashCommand.secrets), 0);
        return true;
      default:
        return false;
    }
  }

  function slashCommandName(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) return null;
    return trimmed.slice(1).split(/\s+/, 1)[0] ?? null;
  }

  function openAgentConfigMenu(): boolean {
    if (chatSession.canChangeAgent) {
      setTimeout(() => pushPromptMenu(configMenuValue(AGENT_CONFIG_OPTION_ID)), 0);
    }
    return true;
  }

  function pushPromptMenu(value: string): void {
    (
      prompt as Prompt.Root & {
        menus?: {
          push(value: string): void;
        };
      }
    )?.menus?.push(value);
  }

  function promptContent(value: string): ContentBlock[] {
    return buildACPPromptContent(
      value,
      pastedAttachments?.contentBlocks() ?? [],
      contextRepo.asPromptContentBlocks(chatSession.promptContentOptions.supportsEmbeddedContext),
      chatSession.promptContentOptions,
    );
  }

  function scheduleDraftSidebarPreview(
    conversationId: string,
    value: string,
    { updateTitle }: { updateTitle: boolean },
  ): void {
    pendingDraftSidebarPreview = { conversationId, value, updateTitle };
    if (draftSidebarPreviewTimer) {
      clearTimeout(draftSidebarPreviewTimer);
    }
    draftSidebarPreviewTimer = setTimeout(() => {
      draftSidebarPreviewTimer = undefined;
      const next = pendingDraftSidebarPreview;
      pendingDraftSidebarPreview = undefined;
      if (next) applyDraftSidebarPreview(next);
    }, DRAFT_SIDEBAR_PREVIEW_DEBOUNCE_MS);
  }

  function clearDraftSidebarPreview(): void {
    if (draftSidebarPreviewTimer) {
      clearTimeout(draftSidebarPreviewTimer);
      draftSidebarPreviewTimer = undefined;
    }
    pendingDraftSidebarPreview = undefined;
  }

  function flushDraftSidebarPreview(): void {
    if (draftSidebarPreviewTimer) {
      clearTimeout(draftSidebarPreviewTimer);
      draftSidebarPreviewTimer = undefined;
    }
    const next = pendingDraftSidebarPreview;
    pendingDraftSidebarPreview = undefined;
    if (next) applyDraftSidebarPreview(next);
  }

  function applyDraftSidebarPreview(next: NonNullable<typeof pendingDraftSidebarPreview>): void {
    if (chatSession.isSending) return;
    if (next.updateTitle) {
      conversations.setDraftTitle(next.conversationId, next.value);
    } else {
      conversations.setDraftPromptPresence(next.conversationId, next.value.trim().length > 0);
    }
  }

  onDestroy(flushDraftSidebarPreview);

  async function dumpActiveACPConversation(): Promise<void> {
    if (!acpConnectionPool) {
      rpc.showInfoMessage("ACP dump is unavailable", InfoMessageType.error);
      return;
    }

    const server = chatSession.sessionAgentServer ?? chatSession.activeAgentServer;
    const entries = scopeTrajectoryToConversation(
      acpConnectionPool.debug.dump(server),
      chatSession.sessionId,
    );
    const data = JSON.stringify(entries, null, 2);
    await saveACPConversationDump(data, $appState.environment.assistantHost);
  }

  async function loadACPConversation(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (!acpConnectionPool) {
          rpc.showInfoMessage("ACP dump loading is unavailable", InfoMessageType.error);
          return;
        }

        const entries = normalizeDumpEntries(JSON.parse(await file.text()));
        await acpConnectionPool.debug.load(entries, chatSession.activeAgentServer);
        rpc.showInfoMessage("ACP dump loaded", InfoMessageType.info);
      } catch (error) {
        console.error("Failed to load ACP dump", error);
        rpc.showInfoMessage("Failed to load ACP dump", InfoMessageType.error);
      }
    };
    input.click();
  }

  let capabilities = $derived($appState.environment.capabilities);
  let supportsSymbolsMenu = $derived(
    capabilities.fileContext && $appState.environment.assistantHost !== "desktop",
  );
  let draftPrompt = $derived(draftKey ? (draftPrompts.get(draftKey) ?? "") : "");

  $effect(() => {
    promptValue = draftPrompt;
  });

  // Dictation lands in this prompt: the text present when recording started
  // is kept, and the transcript is appended after it once transcription ends.
  let dictationBase = "";
  let voicePhase = $derived(voiceInputStore.phase);

  function joinDictation(text: string): string {
    return dictationBase ? `${dictationBase} ${text}` : text;
  }

  $effect(() =>
    voiceInputStore.registerSink({
      onDictationStart: () => {
        dictationBase = promptValue.trimEnd();
      },
      onDictationEnd: (text) => {
        if (text) {
          const value = joinDictation(text);
          // restore replaces the editor content and focuses it, but it
          // suppresses the editor's value-change callback (it exists for
          // programmatic draft swaps). Run the draft handler ourselves so the
          // dictated text counts as composed input — otherwise the next
          // dictation would read a stale base and overwrite this one.
          prompt?.restore(value);
          handleDraftPromptChange(value);
        }
      },
    }),
  );

  function handleDraftPromptChange(value: string): void {
    promptValue = value;
    if (value) {
      // Surface a draft in the sidebar as soon as the user starts composing, so
      // it can be left and returned to (no send required).
      chatSession.ensureDraftPersisted();
    }
    // Mirror the composed text as the draft's sidebar title (front-end only),
    // reverting to "New conversation" when the draft is emptied. Skip while a
    // send is in flight so a just-sent conversation isn't reset before the agent
    // retitles it.
    const draftConversationId = chatSession.pendingConversationId;
    if (draftConversationId && !chatSession.isSending) {
      scheduleDraftSidebarPreview(draftConversationId, value, { updateTitle: true });
    } else if (chatSession.conversationId && !chatSession.isSending) {
      scheduleDraftSidebarPreview(chatSession.conversationId, value, { updateTitle: false });
    }
    if (!draftKey) return;
    if (value) {
      draftPrompts.set(draftKey, value);
    } else {
      draftPrompts.delete(draftKey);
    }
  }

  // Flows that land the user here ready to type ("New conversation", "Add
  // project") request focus on the session; consume it only once focusing
  // succeeds — on the first run after a fresh mount the editor may not be
  // attached yet, so retry once after the next frame.
  $effect(() => {
    if (!chatSession.promptFocusRequested) return;
    if (prompt?.focus()) {
      chatSession.consumePromptFocusRequest();
      return;
    }
    const handle = requestAnimationFrame(() => {
      if (chatSession.promptFocusRequested && prompt?.focus()) {
        chatSession.consumePromptFocusRequest();
      }
    });
    return () => cancelAnimationFrame(handle);
  });
</script>

<Prompt.Root
  onInterrupt={isTurnActive ? onInterrupt : undefined}
  value={draftPrompt}
  suggestion={isTurnActive || resolvedDisabled ? null : chatSession.promptSuggestion?.text}
  onSuggestionAccepted={() => chatSession.clearPromptSuggestion()}
  onValueChange={handleDraftPromptChange}
  onSubmit={submit}
  onSubmitNow={submitNow}
  submitDisabled={resolvedSubmitDisabled}
  disabled={resolvedDisabled}
  bind:this={prompt}
  {...rest}
>
  <DesktopFilePromptChipInserter enabled={desktopFilePromptChipTarget} />
  <PastedAttachments bind:this={pastedAttachments} enabled={desktopFilePromptChipTarget} />
  {@render promptBanners?.()}
  <ConfigValueMenus {onConfigureAgents} />

  <Prompt.Menu.Root {...acpMenus.command}>
    <CommandMenu
      onCommand={handleCommand}
      {promptCommandItems}
      fallbackSkills={installedSkills.commands}
    />
  </Prompt.Menu.Root>

  <Prompt.Menu.Root {...acpMenus.skills}>
    <SkillsMenu fallbackSkills={installedSkills.commands} />
  </Prompt.Menu.Root>

  <Prompt.Menu.Root {...menus.secrets}>
    <SecretsMenu />
  </Prompt.Menu.Root>

  <Prompt.Menu.Root {...menus["secret-edit"]}>
    <SecretEditMenu />
  </Prompt.Menu.Root>

  {#if capabilities.fileContext}
    <Prompt.Menu.Root {...menus.files}>
      <FilesMenu />
    </Prompt.Menu.Root>

    <Prompt.Menu.Root {...menus.websites}>
      <WebsitesMenu />
    </Prompt.Menu.Root>

    {#if supportsSymbolsMenu}
      <Prompt.Menu.Root {...menus.symbols}>
        <SymbolsMenu />
      </Prompt.Menu.Root>
    {/if}
  {/if}

  {@render promptMenus?.()}

  {#if isMobile && (chatSession.configOptions.length > 0 || chatSession.goal)}
    <!-- Accessory strip above the pill composer: permission mode (with the
         plan chip beside it) leading, the consolidated agent/model/options
         trigger trailing. The pill's shrunken footer (see mobile-remote
         app.css) has no room for them. -->
    <div class="flex min-w-0 items-center justify-between gap-2 px-1 pb-1" data-size="xs">
      <div class="flex min-w-0 items-center gap-1">
        <PromptModeControl />
        <PromptModeControl kind="collaboration" />
        <PlanModeIndicator />
        <GoalIndicator />
      </div>
      <div
        class="prompt-config-controls-visibility flex min-w-0"
        class:prompt-config-controls-hidden={!showConfigControls}
        aria-hidden={!showConfigControls}
        inert={!showConfigControls}
      >
        <PromptConfigControls />
      </div>
    </div>
  {/if}

  <div
    class="dictation-scope"
    class:prompt-desktop={isDesktop}
    class:dictation-recording={voicePhase === "recording"}
    class:dictation-transcribing={voicePhase === "transcribing"}
  >
    <Prompt.Form.Root>
      <Prompt.Form.Field.Root>
        <Prompt.Form.Field.Editor.Root id="prompt-editor">
          <Prompt.Form.Field.Editor.Suggestion />
          <Prompt.Form.Field.Editor.Placeholder>
            {#if localModelMissing}
              No model available
            {:else}
              Ask {currentAgentName} something...
            {/if}
          </Prompt.Form.Field.Editor.Placeholder>
        </Prompt.Form.Field.Editor.Root>
      </Prompt.Form.Field.Root>
      <Prompt.Form.Footer
        data-size="sm"
        class={["justify-between gap-2 pb-1.5 pl-2 pr-2", isDesktop && "mt-2"]}
      >
        <!-- Leading cluster: slash command, permission mode, and — while a
             collaboration-mode agent is planning — the plan chip. The slash
             trigger is sized to match the mode control (h-7) so the row keeps
             an even rhythm. -->
        <div class="flex min-w-0 items-center gap-1" data-size="xs" bind:this={leadingClusterEl}>
          <Prompt.Menu.Trigger
            appearance="ghost"
            value={acpMenus.command.value}
            class="!text-psx-icon !m-0 flex !size-7 items-center justify-center rounded-md"
          >
            <Icon name="slash" />
          </Prompt.Menu.Trigger>
          {#if !isMobile}
            <PromptModeControl />
            <PromptModeControl kind="collaboration" />
            <PlanModeIndicator />
            <GoalIndicator />
          {/if}
          {@render footerLeading?.()}
        </div>

        {#if voicePhase === "recording"}
          <DictationWaveform />
        {/if}

        <!-- Trailing cluster: agent, model, fast mode, effort, then compose
             actions. Config controls collapse (see reflowFooter) when tight;
             min-w-0 lets the config trigger's label truncate on narrow
             (mobile) footers instead of pushing the send button off-screen. -->
        <div class="flex min-w-0 items-center gap-0.5" data-size="xs" bind:this={trailingClusterEl}>
          {#if !isMobile}
            <div
              class="prompt-config-controls-visibility flex min-w-0"
              class:prompt-config-controls-hidden={!showConfigControls}
              aria-hidden={!showConfigControls}
              inert={!showConfigControls}
            >
              <PromptConfigControls hiddenCount={configHiddenCount} />
            </div>
          {/if}
          <div class="ml-1 flex shrink-0 items-center gap-1">
            <SpeechButton disabled={resolvedDisabled} />
            {#if isTurnActive}
              {#if chatSession.canEnqueuePrompt && hasPromptContent}
                <ActivePromptSubmit
                  canSteerPrompt={chatSession.canSteerPrompt}
                  {steerWithEnter}
                  oncontextmenu={openPromptSubmitContextMenu}
                />
              {/if}
              <Prompt.Form.SubmitButton
                icon="stop"
                label="Stop"
                title={withShortcut("Stop", "interrupt")}
                onclick={onInterrupt}
              />
            {:else}
              <Prompt.Form.Submit icon="submit-solid" />
            {/if}
          </div>
        </div>
      </Prompt.Form.Footer>
    </Prompt.Form.Root>
  </div>
</Prompt.Root>

<style lang="postcss">
  .prompt-config-controls-visibility {
    opacity: 1;
    transition: opacity 180ms ease-out;
  }

  .prompt-config-controls-hidden {
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
  }

  .dictation-scope {
    display: contents;
  }

  .dictation-scope.prompt-desktop :global(form) {
    border-radius: 12px;
    /* ChatPane publishes the composer's text size so the elicitation form
       above the prompt can match it. The fallback keeps this rule standing on
       its own wherever the prompt renders outside that column. */
    font-size: var(--psx-composer-font-size, 15px);
    border-color: transparent;
    outline: 1px solid rgb(0 0 0 / 8%);
    outline-offset: -1px;
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 8%);
  }

  :global(.vscode-dark) .dictation-scope.prompt-desktop :global(form) {
    outline-color: rgb(255 255 255 / 6%);
  }

  /* While dictating, the prompt box carries the accent color (red reads as an
     error) and the footer waveform shows speech being heard; transcribing
     settles into a steady glow until the final text lands. Targets the form
     element Prompt.Form.Root renders. */
  .dictation-scope.dictation-recording :global(form) {
    border-color: color-mix(in srgb, var(--color-psx-focus) 70%, transparent);
    animation: dictation-breathe 1.8s ease-in-out infinite;
  }

  .dictation-scope.dictation-transcribing :global(form) {
    border-color: var(--color-psx-focus);
    box-shadow: 0 0 10px 1px color-mix(in srgb, var(--color-psx-focus) 30%, transparent);
    transition: box-shadow 300ms ease;
  }

  @keyframes dictation-breathe {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-psx-focus) 25%, transparent);
    }
    50% {
      box-shadow: 0 0 14px 3px color-mix(in srgb, var(--color-psx-focus) 40%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt-config-controls-visibility {
      transition-duration: 0ms;
    }
  }
</style>
