<script lang="ts">
  import { vi } from "vitest";
  import {
    ClipboardProvider,
    DisplayProvider,
    EnvironmentProvider,
    LogProvider,
  } from "@camber/components/providers";
  import { _setContextRepoContextForTests } from "../../../context";
  import { setElicitationContext } from "../../../elicitation";
  import AcpChatPane from "./ChatPane.svelte";
  import {
    _setACPContextForTests,
    type ACPSessionRepository,
  } from "../../features/SessionRepository.svelte";
  import {
    _setACPSetupScriptOutputContextForTests,
    AcpSetupScriptOutputRepositoryWriter,
  } from "../../features/SetupScriptOutputRepository.svelte";
  import { _setACPAgentServersContextForTests } from "../../features/AgentServersRepository.svelte";
  import { _setACPAgentUpdateContextForTests } from "../../features/AgentUpdateRepository.svelte";
  import {
    _setACPConversationContextForTests,
    type ACPConversationRepository,
  } from "../../features/ConversationRepository.svelte";
  import { _setACPProjectContextForTests } from "../../features/ProjectRepository.svelte";
  import { _setACPWorktreeContextForTests } from "../../features/WorktreeRepository";
  import { setAssistantTerminalContext } from "../../features/AssistantTerminalRepository.svelte";
  import { setACPAgentRegistryContext } from "../../features/AgentRegistryRepository.svelte";
  import {
    setACPConversationStatusContext,
    type ACPConversationStatusRepository,
  } from "../../features/ConversationStatusRepository.svelte";
  import { setNotificationContext } from "../../features/NotificationRepository.svelte";
  import AcpHandoffConfirmationProvider from "../HandoffConfirmationProvider.svelte";

  interface Props {
    sessionRepo: ACPSessionRepository;
    conversationRepo: ACPConversationRepository;
    activeConversationId?: string | null;
    promptBannerText?: string;
    promptCommandItemText?: string;
    agentServersState?: { status: string };
    markReadWhenVisible?: boolean;
    readOnlyPreview?: boolean;
    onNewConversation?: () => void;
    onAddProject?: () => void;
    onShowAgentSettings?: () => void;
  }

  let {
    sessionRepo,
    conversationRepo,
    activeConversationId = (sessionRepo as any).conversationId ?? null,
    promptBannerText,
    promptCommandItemText,
    agentServersState = { status: "success" },
    markReadWhenVisible = true,
    readOnlyPreview = false,
    onNewConversation = vi.fn(),
    onAddProject = vi.fn(),
    onShowAgentSettings = vi.fn(),
  }: Props = $props();

  let currentConversationId = $state(activeConversationId);

  _setACPContextForTests(sessionRepo);
  _setACPSetupScriptOutputContextForTests(new AcpSetupScriptOutputRepositoryWriter());
  _setACPAgentServersContextForTests({
    state: agentServersState,
    refresh: vi.fn().mockResolvedValue(undefined),
    setDefaultAgentServer: vi.fn().mockResolvedValue(undefined),
  } as any);
  _setACPAgentUpdateContextForTests({
    updates: [],
    busyAgentServer: null,
    stage: null,
    error: null,
    refresh: vi.fn().mockResolvedValue([]),
    updateFor: vi.fn(() => undefined),
    hasUpdate: vi.fn(() => false),
    progressFor: vi.fn(() => null),
    busyLabel: vi.fn(() => ""),
    update: vi.fn().mockResolvedValue(undefined),
  } as any);
  _setACPConversationContextForTests(conversationRepo);
  _setACPProjectContextForTests(conversationRepo as any);
  _setACPWorktreeContextForTests(conversationRepo as any);
  setAssistantTerminalContext();
  setACPAgentRegistryContext();
  const notificationRepo = setNotificationContext(
    () => {},
    (agentServer: string) => agentServer,
    () => false,
    () => true,
  );
  const conversationStatus = setACPConversationStatusContext(
    notificationRepo.publicAPI(),
  ).publicAPI() as ACPConversationStatusRepository;
  setElicitationContext(conversationStatus);
  _setContextRepoContextForTests();
</script>

<EnvironmentProvider name="test">
  <LogProvider onError={vi.fn()} onInfo={vi.fn()}>
    <ClipboardProvider onWrite={vi.fn()}>
      <DisplayProvider>
        <AcpHandoffConfirmationProvider>
          <AcpChatPane
            activeConversationId={currentConversationId}
            onActiveConversationIdChange={(id) => (currentConversationId = id)}
            {markReadWhenVisible}
            {readOnlyPreview}
            {onNewConversation}
            {onAddProject}
            {onShowAgentSettings}
          >
            {#snippet promptBanners()}
              {#if promptBannerText}
                <div data-testid="injected-prompt-banner">{promptBannerText}</div>
              {/if}
            {/snippet}
            {#snippet promptCommandItems()}
              {#if promptCommandItemText}
                <div data-testid="injected-command-item">{promptCommandItemText}</div>
              {/if}
            {/snippet}
          </AcpChatPane>
        </AcpHandoffConfirmationProvider>
      </DisplayProvider>
    </ClipboardProvider>
  </LogProvider>
</EnvironmentProvider>
