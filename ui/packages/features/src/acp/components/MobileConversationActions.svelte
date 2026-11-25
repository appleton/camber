<script lang="ts">
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { containingWorktree, registerConversationActions } from "../conversationActions.svelte";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { getACPProjectRepo } from "../features/ProjectRepository.svelte";
  import type { ACPSession } from "../features/Session.svelte";
  import { getACPWorktreeRepo } from "../features/WorktreeRepository";
  import { rpc } from "../hostRpc";
  import { dedupeConversationSummaries, type ACPConversationSummary } from "../navTypes";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";

  // Mobile counterpart of the desktop sidebar's registration for the composer's
  // /archive and /delete-worktree. The mobile conversation list is unmounted
  // while a chat is open, so the shell mounts this instead. Like the list's own
  // actions, archive is immediate (no undo countdown) and worktree deletion
  // asks for confirmation first.

  interface Props {
    activeConversationId: string | null;
    activeSession: ACPSession | null;
    /** Leave the open conversation, e.g. return to the conversation list. */
    onLeaveConversation: () => void;
  }

  let { activeConversationId, activeSession, onLeaveConversation }: Props = $props();

  const conversations = getACPConversationRepo();
  const projects = getACPProjectRepo();
  const worktrees = getACPWorktreeRepo();

  const archiving = new SvelteSet<string>();
  let deleteWorktreeTarget = $state<{ path: string; name: string } | null>(null);

  function summary(conversationId: string): ACPConversationSummary | undefined {
    return dedupeConversationSummaries(conversations.sessions).find(
      (session) => session.id === conversationId,
    );
  }

  // Mirrors MobileSideBar: only idle worktrees can be deleted.
  function deletableWorktree(path: string) {
    const worktree = projects.projects.find(
      (project) => project.isWorktree && project.path === path,
    );
    if (!worktree || worktree.deleteRequested === true || worktree.busy !== undefined) return null;
    return worktree;
  }

  async function archive(session: ACPConversationSummary) {
    archiving.add(session.id);
    const agentServer = session.agentServer || "poolside";
    const live = activeSession;
    const isActive = activeConversationId === session.id;
    try {
      if (
        isActive &&
        live?.sessionId === session.sessionId &&
        (live.isPrompting || live.isSending)
      ) {
        await live.cancel();
      }
      await conversations.archiveSession(session.cwd, session.sessionId, agentServer, session.id);
      if (activeConversationId === session.id) onLeaveConversation();
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to archive conversation" }),
        InfoMessageType.error,
      );
    } finally {
      archiving.delete(session.id);
    }
  }

  async function removeWorktree(path: string) {
    const leaving = (() => {
      const active = activeConversationId ? summary(activeConversationId) : undefined;
      return !!active && containingWorktree(projects.projects, active.cwd)?.path === path;
    })();
    try {
      projects.setWorktreeBusy(path, "tearing_down");
      await worktrees.removeWorktree(path, (kind) => projects.setWorktreeBusy(path, kind));
      await projects.refresh();
      await conversations.refresh();
      if (leaving) onLeaveConversation();
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to delete worktree" }),
        InfoMessageType.error,
      );
    } finally {
      projects.clearWorktreeBusy(path);
    }
  }

  onMount(() =>
    registerConversationActions({
      canArchive: (conversationId) =>
        !archiving.has(conversationId) && summary(conversationId) !== undefined,
      archiveConversation: (conversationId) => {
        if (archiving.has(conversationId)) return false;
        const session = summary(conversationId);
        if (!session) return false;
        void archive(session);
        return true;
      },
      worktreeFor: (conversationId) => {
        const session = summary(conversationId);
        if (!session) return null;
        const worktree = containingWorktree(projects.projects, session.cwd);
        if (!worktree || !deletableWorktree(worktree.path)) return null;
        return { path: worktree.path, name: worktree.nickname || worktree.name };
      },
      deleteWorktree: (path) => {
        const worktree = deletableWorktree(path);
        if (!worktree) return;
        deleteWorktreeTarget = { path, name: worktree.nickname || worktree.name };
      },
    }),
  );
</script>

{#if deleteWorktreeTarget}
  <ConfirmationDialog
    destructive
    title="Delete worktree?"
    description={`Delete ${deleteWorktreeTarget.name}. This removes the worktree from disk and cannot be undone.`}
    confirmLabel="Delete Worktree"
    onCancel={() => (deleteWorktreeTarget = null)}
    onConfirm={async () => {
      const target = deleteWorktreeTarget;
      if (!target) return;
      await removeWorktree(target.path);
      deleteWorktreeTarget = null;
    }}
  />
{/if}
