<script lang="ts">
  import type { LocalInferenceState } from "@camber/helperapi/schemas";
  import { onDestroy, type Snippet } from "svelte";
  import { appState } from "../hostAdapter";
  import type { Capabilities } from "../hostAdapter";
  import type { ACPNavConversation, ACPNavProject } from "../navTypes";
  import {
    _setACPAgentUpdateContextForTests,
    type ACPAgentUpdateRepository,
  } from "../features/AgentUpdateRepository.svelte";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { setLocalInferenceContext } from "../features/LocalInferenceRepository.svelte";
  import { getACPProjectRepo } from "../features/ProjectRepository.svelte";

  interface Props {
    children: Snippet;
    projects?: ACPNavProject[];
    conversations?: ACPNavConversation[];
    capabilities?: Partial<Capabilities>;
    // Seeds the local-inference repository, e.g. with a resident model so the
    // sidebar runtime pill renders.
    localInference?: LocalInferenceState;
    // Conversation ids whose sub-agent lists start expanded. Written to
    // storage synchronously, before the sidebar mounts and reads it, and
    // removed on teardown so it cannot leak into the next story.
    expandedSubAgents?: string[];
    // Replaces the repository's archive call (tests).
    archiveSession?: (...args: unknown[]) => Promise<unknown>;
    // Hands the conversation repository to tests so they can change nav state.
    onConversationRepo?: (repo: ReturnType<typeof getACPConversationRepo>) => void;
  }

  let {
    children,
    projects = [],
    conversations = [],
    capabilities,
    localInference,
    expandedSubAgents,
    archiveSession,
    onConversationRepo,
  }: Props = $props();

  const SUB_AGENTS_EXPANDED_KEY = "camber.desktop.expandedSubAgents.v1";
  if (expandedSubAgents) {
    globalThis.localStorage?.setItem(SUB_AGENTS_EXPANDED_KEY, JSON.stringify(expandedSubAgents));
    onDestroy(() => globalThis.localStorage?.removeItem(SUB_AGENTS_EXPANDED_KEY));
  }

  if (capabilities) {
    appState.update((state) => ({
      ...state,
      environment: {
        ...state.environment,
        capabilities: { ...state.environment.capabilities, ...capabilities },
      },
    }));
  }

  const projectRepo = getACPProjectRepo();
  const conversationRepo = getACPConversationRepo();
  const localInferenceRepo = setLocalInferenceContext();
  // The desktop sidebar only reads pending updates; stories have none.
  _setACPAgentUpdateContextForTests({ updates: [] } as unknown as ACPAgentUpdateRepository);

  projectRepo.replaceProjects(projects);
  conversationRepo.replaceConversations(conversations);
  onConversationRepo?.(conversationRepo);

  // The sidebars call `refresh()` from onMount whenever the list arrives empty,
  // which would hit the real helper RPC and surface a failure banner.
  (projectRepo as { refresh: () => Promise<void> }).refresh = async () => {};
  (conversationRepo as { refresh: () => Promise<void> }).refresh = async () => {};
  if (archiveSession) {
    (conversationRepo as { archiveSession: unknown }).archiveSession = archiveSession;
  }
  localInferenceRepo.refresh = async () => {};
  localInferenceRepo.unloadModel = async () => {};
  if (localInference) {
    localInferenceRepo.state = localInference;
  }
</script>

{@render children()}
