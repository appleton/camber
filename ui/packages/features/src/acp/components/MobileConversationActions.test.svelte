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
  import type { ACPConversationSummary, ACPNavProject } from "../navTypes";
  import MobileConversationActions from "./MobileConversationActions.svelte";

  interface Props {
    projects: ACPNavProject[];
    sessions: ACPConversationSummary[];
    activeConversationId: string | null;
    archiveSession?: (...args: unknown[]) => Promise<void>;
    removeWorktree?: (path: string) => Promise<void>;
    onLeaveConversation: () => void;
  }

  let {
    projects,
    sessions,
    activeConversationId,
    archiveSession = async () => {},
    removeWorktree = async () => {},
    onLeaveConversation,
  }: Props = $props();

  _setACPProjectContextForTests({
    projects,
    refresh: async () => {},
    setWorktreeBusy: () => {},
    clearWorktreeBusy: () => {},
  } as unknown as ACPProjectRepository);
  _setACPConversationContextForTests({
    sessions,
    refresh: async () => {},
    archiveSession: (...args: unknown[]) => archiveSession(...args),
  } as unknown as ACPConversationRepository);
  _setACPWorktreeContextForTests({
    removeWorktree: (path: string) => removeWorktree(path),
  } as unknown as ACPWorktreeRepository);
</script>

<MobileConversationActions {activeConversationId} activeSession={null} {onLeaveConversation} />
