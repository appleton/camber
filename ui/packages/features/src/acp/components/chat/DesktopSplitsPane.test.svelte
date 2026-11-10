<script lang="ts">
  import {
    ClipboardProvider,
    DisplayProvider,
    EnvironmentProvider,
    LogProvider,
  } from "@camber/components/providers";
  import { vi } from "vitest";
  import { _setContextRepoContextForTests } from "../../../context";
  import {
    _setACPAgentRegistryContextForTests,
    type AcpAgentRegistryRepository,
  } from "../../features/AgentRegistryRepository.svelte";
  import { setAssistantTerminalContext } from "../../features/AssistantTerminalRepository.svelte";
  import {
    _setACPConversationContextForTests,
    type ACPConversationRepository,
  } from "../../features/ConversationRepository.svelte";
  import {
    _setACPProjectContextForTests,
    type ACPProjectRepository,
  } from "../../features/ProjectRepository.svelte";
  import { setACPGithubContext } from "../../features/GithubRepository.svelte";
  import {
    _setACPContextForTests,
    type ACPSessionRepository,
  } from "../../features/SessionRepository.svelte";
  import type { ACPRegistryAgent } from "../../agentRegistry";
  import type { SessionEvent } from "../../types";
  import DesktopSplitsPane from "./DesktopSplitsPane.svelte";
  import type { DesktopSplitsCache } from "./desktopSplitsCache";

  interface Props {
    events: SessionEvent[];
    splitsCache: DesktopSplitsCache;
  }

  let { events, splitsCache }: Props = $props();
  const session = {
    sessionId: "session-test",
    conversationId: "conversation-test",
    agentServer: "claude-acp",
    cwd: "/workspace",
    pendingCwd: null,
    pendingConversationId: null,
    isChat: false,
    sessionInfo: {
      sessionId: "session-test",
      conversationId: "conversation-test",
      cwd: "/workspace",
      readOnly: false,
    },
    loadState: { status: "success", value: undefined },
    setupStatus: null,
    get events() {
      return events;
    },
    turns: [],
    get isPrompting() {
      return events.some(
        (event) => event.eventKind === "tool_call" && event.status === "in_progress",
      );
    },
    get isPromptActive() {
      return this.isPrompting;
    },
    get activeTurnStartIndex() {
      return this.isPrompting ? 0 : null;
    },
    isSending: false,
    pendingPermissionRequests: [],
  };
  const claudeAgent = {
    id: "claude-acp",
    name: "Claude",
    version: "test",
    description: "Claude test agent",
    icon: "./claude.svg",
    distribution: {},
  } satisfies ACPRegistryAgent;
  const sessionRepo = {
    getSessionByConversationId: () => session,
    getConversationStatus: () => ({
      working: session.isPrompting,
      waitingForUser: false,
      unread: false,
    }),
    agents: { defaultAgentServer: "claude-acp" },
  } as unknown as ACPSessionRepository;

  _setACPContextForTests(sessionRepo);
  _setACPConversationContextForTests({ sessions: [] } as unknown as ACPConversationRepository);
  _setACPProjectContextForTests({ projects: [] } as unknown as ACPProjectRepository);
  _setACPAgentRegistryContextForTests({
    getAgent: (id: string) => (id === "claude-acp" ? claudeAgent : undefined),
  } as unknown as AcpAgentRegistryRepository);
  setAssistantTerminalContext();
  setACPGithubContext();
  _setContextRepoContextForTests();
</script>

<EnvironmentProvider name="test">
  <LogProvider onError={vi.fn()} onInfo={vi.fn()}>
    <ClipboardProvider onWrite={vi.fn()}>
      <DisplayProvider>
        <DesktopSplitsPane
          layoutKey="conversation-test"
          {splitsCache}
          terminalWorktreePath="/workspace"
          activeConversationId="conversation-test"
          onNewConversation={vi.fn()}
          onAddProject={vi.fn()}
          onShowAgentSettings={vi.fn()}
        />
      </DisplayProvider>
    </ClipboardProvider>
  </LogProvider>
</EnvironmentProvider>
