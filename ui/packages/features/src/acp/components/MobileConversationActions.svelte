<script lang="ts">
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    isWorktreeConversation,
    registerConversationActions,
  } from "../conversationActions.svelte";
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
  // `origin` is the conversation whose composer asked: on mobile, the open one.
  let deleteWorktreeTarget = $state<{
    path: string;
    name: string;
    origin: string | null;
  } | null>(null);

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
    try {
      await cancelRunningTurn(session);
      // The conversation plus the same-group sub-agents the helper archived
      // with it, any of which the user may have opened in the meantime. The
      // repository closes the requested session whatever the helper reports,
      // so staying in it would leave a chat stuck loading.
      const archived = new Set([
        session.id,
        ...(await conversations.archiveSession(
          session.cwd,
          session.sessionId,
          agentServer,
          session.id,
        )),
      ]);
      if (activeConversationId && archived.has(activeConversationId)) onLeaveConversation();
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to archive conversation" }),
        InfoMessageType.error,
      );
    } finally {
      archiving.delete(session.id);
    }
  }

  // A turn may be running on this phone or on another surface (pushed as the
  // conversation's live status); either way, stop it first.
  async function cancelRunningTurn(session: ACPConversationSummary) {
    const live = activeSession;
    if (!live || activeConversationId !== session.id || live.sessionId !== session.sessionId)
      return;
    if (live.isPrompting || live.isSending || session.liveStatus?.working) await live.cancel();
  }

  // Errors propagate so the confirmation dialog stays open with the message.
  async function removeWorktree(path: string, origin: string | null) {
    const sessions = dedupeConversationSummaries(conversations.sessions);
    // Snapshot before teardown: the helper's navigation update can land before
    // removal returns. It archives or deletes the worktree's conversations by
    // stored workspace, and cascades to sub-agents grouped by cwd.
    // The conversation that asked is in the worktree, even if the list is
    // empty because a background refresh failed while the dialog was open.
    const affected = new Set([
      ...(origin ? [origin] : []),
      ...sessions.filter((session) => session.workspacePath === path).map((session) => session.id),
    ]);
    const inWorktree = new Set(
      sessions.filter((session) => session.cwd === path).map((session) => session.id),
    );
    const running = sessions.find(
      (session) => session.id === activeConversationId && session.cwd === path,
    );
    if (running) await cancelRunningTurn(running);
    try {
      projects.setWorktreeBusy(path, "tearing_down");
      await worktrees.removeWorktree(path, (kind) => projects.setWorktreeBusy(path, kind));
    } catch (error) {
      // Removal can fail after the worktree is already gone (e.g. its
      // terminal cleanup lost the connection): only offer a retry if it isn't.
      if (!(await worktreeRemoved(path))) throw error;
      console.error("Worktree deleted, but cleanup afterwards failed", error);
    } finally {
      projects.clearWorktreeBusy(path);
    }
    // Refreshes record failures instead of throwing, and an unrefreshed list
    // is empty: only trust a list whose refresh succeeded.
    await projects.refresh({ showLoading: false });
    await conversations.refresh({ showLoading: false });
    const listed = conversations.refreshState.status === "success";
    // Leave only if the user is still in a conversation the removal took;
    // teardown is slow, and they may have opened another chat meanwhile.
    const current = activeConversationId;
    if (!current) return;
    const cascaded = listed && inWorktree.has(current) && summary(current) === undefined;
    if (affected.has(current) || cascaded) onLeaveConversation();
  }

  async function worktreeRemoved(path: string): Promise<boolean> {
    await projects.refresh({ showLoading: false });
    if (projects.refreshState.status !== "success") return false;
    return !projects.projects.some((project) => project.path === path);
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
        if (!isWorktreeConversation(session)) return null;
        const worktree = deletableWorktree(session.cwd);
        if (!worktree) return null;
        return { path: worktree.path, name: worktree.nickname || worktree.name };
      },
      deleteWorktree: (path) => {
        const worktree = deletableWorktree(path);
        if (!worktree) return;
        deleteWorktreeTarget = {
          path,
          name: worktree.nickname || worktree.name,
          origin: activeConversationId,
        };
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
      await removeWorktree(target.path, target.origin);
      deleteWorktreeTarget = null;
    }}
  />
{/if}
