<script lang="ts">
  import {
    _setACPConversationContextForTests,
    type ACPConversationRepository,
  } from "../features/ConversationRepository.svelte";
  import {
    _setACPProjectContextForTests,
    type ACPProjectRepository,
  } from "../features/ProjectRepository.svelte";
  import {
    _setACPWorktreeContextForTests,
    type ACPWorktreeRepository,
  } from "../features/WorktreeRepository";
  import type { ACPSession } from "../features/Session.svelte";
  import type { ACPConversationSummary, ACPNavProject } from "../navTypes";
  import MobileConversationActions from "./MobileConversationActions.svelte";

  interface Props {
    projects: ACPNavProject[];
    sessions: ACPConversationSummary[];
    activeConversationId: string | null;
    activeSession?: ACPSession | null;
    archiveSession?: (...args: unknown[]) => Promise<string[]>;
    removeWorktree?: (path: string) => Promise<void>;
    onLeaveConversation: () => void;
    /** The helper can't be reached: refreshes record a failure and lists are empty. */
    refreshFails?: boolean;
  }

  let {
    projects,
    sessions,
    activeConversationId,
    activeSession = null,
    archiveSession = async () => [],
    removeWorktree = async () => {},
    onLeaveConversation,
    refreshFails = false,
  }: Props = $props();

  // A failing refresh records the failure and empties the list, like the
  // real repository, rather than throwing.
  const projectRepo = {
    projects,
    refreshState: { status: "success", value: projects } as unknown,
    refresh: async () => {
      if (!refreshFails) return;
      projectRepo.projects = [];
      projectRepo.refreshState = { status: "failure", error: new Error("offline") };
    },
    setWorktreeBusy: () => {},
    clearWorktreeBusy: () => {},
  };
  _setACPProjectContextForTests(projectRepo as unknown as ACPProjectRepository);
  _setACPConversationContextForTests({
    sessions,
    refreshState: { status: "success", value: sessions },
    refresh: async () => {},
    archiveSession: (...args: unknown[]) => archiveSession(...args),
  } as unknown as ACPConversationRepository);
  _setACPWorktreeContextForTests({
    removeWorktree: (path: string) => removeWorktree(path),
  } as unknown as ACPWorktreeRepository);
</script>

<MobileConversationActions {activeConversationId} {activeSession} {onLeaveConversation} />
