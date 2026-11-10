<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import type { GitHubLinksOutput } from "@camber/helperapi";
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { onMount } from "svelte";
  import {
    compareWorktreesByDisplayOrder,
    dedupeConversationSummaries,
    isACPChatConversation,
    worktreeBlocksUI,
    worktreeBusyLabel,
    type ACPConversationSummary,
    type ACPNavProject,
  } from "../navTypes";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { getACPGithubRepo } from "../features/GithubRepository.svelte";
  import { getACPProjectRepo } from "../features/ProjectRepository.svelte";
  import { getACPWorktreeRepo } from "../features/WorktreeRepository";
  import type { ACPSession } from "../features/Session.svelte";
  import { rpc } from "../hostRpc";
  import { formatRelativeTimeWithoutAgo } from "../shared/time";
  import {
    camberqaSlotForWorktree,
    camberqaSlotMobileUrl,
    type MobileCamberQAInstance,
  } from "../camberqaMobile";
  import RegistryAgentIcon from "./RegistryAgentIcon.svelte";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";
  import { getOptionalACPConnectionPoolContext } from "../connectionPoolContext";
  import ACPLogCaptureConfirmation from "./sidebar/ACPLogCaptureConfirmation.svelte";
  import { acpLogCaptureMenuAction, type ACPLogCaptureTarget } from "./sidebar/acpLogCapture";
  import { setAcpSidebarController } from "./sidebar/SidebarController.svelte";
  import { longPress } from "./sidebar/longPress";
  import { sidebarOpensViewLabel, sidebarRenameLabel } from "./sidebar/menuLabels";
  import MobileActionSheet, { type MobileSheetItem } from "./sidebar/MobileActionSheet.svelte";
  import RenameDialog from "./sidebar/RenameDialog.svelte";
  import StreamingSequenceLoader from "./ui/StreamingSequenceLoader.svelte";

  interface Props {
    activeConversationId: string | null;
    activeSession?: ACPSession | null;
    onShowChat: () => void;
    onNewConversation: (cwd?: string) => void | Promise<void>;
    // Row taps go through the host's own open logic (on mobile it must not gate
    // on a busy prior session — see MobileShell.openConversation) rather than
    // AcpSidebarController.openSession.
    onOpenConversation: (session: ACPConversationSummary) => void | Promise<void>;
    onActiveConversationIdChange: (id: string | null) => void;
    // CamberQA worktree identity of the serving helper (dev only): enables
    // the "Open Worktree's Mobile App" action for worktrees another live
    // slot on the same machine serves. See camberqaMobile.ts.
    camberqa?: MobileCamberQAInstance | null;
  }

  let {
    activeConversationId,
    activeSession = null,
    onShowChat,
    onNewConversation,
    onOpenConversation,
    onActiveConversationIdChange,
    camberqa = null,
  }: Props = $props();

  const projects = getACPProjectRepo();
  const acpConnectionPool = getOptionalACPConnectionPoolContext();
  const conversations = getACPConversationRepo();
  const worktrees = getACPWorktreeRepo();
  const github = getACPGithubRepo();
  const sidebar = setAcpSidebarController({
    onShowChat,
    onNewConversation,
    getActiveConversationId: () => activeConversationId,
    getActiveSession: () => activeSession,
    setActiveConversationId: (id) => onActiveConversationIdChange(id),
  });

  let sheet = $state<{ title: string; subtitle?: string; actions: MobileSheetItem[] } | null>(null);
  let renameTarget = $state<
    | { kind: "project" | "worktree"; path: string; name: string }
    | { kind: "conversation"; id: string; name: string }
    | null
  >(null);
  let acpLogCaptureTarget = $state<ACPLogCaptureTarget | null>(null);
  let removeProjectTarget = $state<{ path: string; name: string } | null>(null);
  let deleteWorktreeTarget = $state<{ path: string; name: string } | null>(null);
  let deleteConversationTarget = $state<{
    session: ACPConversationSummary;
    name: string;
  } | null>(null);
  let chatsCollapsed = $state(false);

  const navSessions = $derived(dedupeConversationSummaries(conversations.sessions));
  const chatSessions = $derived(navSessions.filter(isACPChatConversation));
  const rootProjects = $derived(projects.projects.filter((project) => !project.isWorktree));
  const isEmpty = $derived(rootProjects.length === 0 && navSessions.length === 0);
  const isLoading = $derived(
    projects.refreshState.status === "loading" || conversations.refreshState.status === "loading",
  );

  onMount(() => {
    if (projects.projects.length === 0) {
      void projects.refresh();
      void conversations.refresh();
    }
  });

  function worktreesFor(projectPath: string): ACPNavProject[] {
    return projects.projects
      .filter((project) => project.parentPath === projectPath)
      .sort(compareWorktreesByDisplayOrder);
  }

  function sessionsFor(workspacePath: string): ACPConversationSummary[] {
    return navSessions.filter((session) => session.cwd === workspacePath);
  }

  function displayName(project: ACPNavProject): string {
    return project.nickname || project.name;
  }

  function toggleCollapsed(project: ACPNavProject) {
    void projects.setProjectCollapsed(project.path, !project.collapsed);
  }

  function openProjectSheet(project: ACPNavProject) {
    const actions: MobileSheetItem[] = [
      {
        name: "New Conversation",
        icon: "new",
        disabled: sidebar.isLoading,
        // The controller returns the new conversation id (desktop uses it to
        // focus the pane); the sheet callback only needs the side effect.
        callback: async () => {
          await sidebar.newConversation(project.path);
        },
      },
      {
        name: "New Worktree",
        icon: "git-branch",
        callback: () => addWorktree(project),
      },
      { kind: "separator" },
      {
        name: "Open GitHub Repository",
        icon: "github",
        callback: () => openGithubUrl(project.path, (links) => links.repoUrl),
      },
      { kind: "separator" },
      {
        name: sidebarRenameLabel("Project"),
        icon: "pencil",
        callback: () => {
          renameTarget = { kind: "project", path: project.path, name: displayName(project) };
        },
      },
      { kind: "separator" },
      {
        name: sidebarOpensViewLabel("Delete Project"),
        icon: "trash",
        danger: true,
        callback: () => {
          removeProjectTarget = { path: project.path, name: displayName(project) };
        },
      },
    ];
    sheet = { title: displayName(project), subtitle: project.path, actions };
  }

  function openWorktreeSheet(worktree: ACPNavProject) {
    const blocked =
      worktree.deleteRequested === true ||
      (worktree.busy !== undefined && worktreeBlocksUI(worktree.busy));
    // Unlike desktop there is no in-flight creation to abort on mobile, so
    // deleting is only offered for idle worktrees.
    const canDelete = worktree.deleteRequested !== true && worktree.busy === undefined;
    const actions: MobileSheetItem[] = [
      {
        name: "New Conversation",
        icon: "new",
        disabled: sidebar.isLoading || blocked,
        callback: async () => {
          await sidebar.newConversation(worktree.path);
        },
      },
      {
        name: "Open Pull Request",
        icon: "git-branch",
        disabled: blocked,
        callback: () => openGithubUrl(worktree.path, (links) => links.prUrl),
      },
    ];
    // CamberQA development only: when another live slot serves this
    // worktree, offer jumping to its mobile app (same origin, that slot's
    // remote port). A full navigation, not window.open — the phone should
    // land in the other instance, not stack PWA windows.
    const slot = camberqaSlotForWorktree(worktree, camberqa);
    if (slot) {
      actions.push({
        name: "Open Worktree's Mobile App",
        icon: "remote-access",
        callback: () => {
          // The handoff hash carries this origin's device token so the
          // target slot (a different origin) signs in without re-pairing.
          window.location.href = camberqaSlotMobileUrl(
            slot,
            window.location,
            camberqa?.getHandoffHash?.() ?? "",
          );
        },
      });
    }
    actions.push(
      { kind: "separator" },
      {
        name: sidebarRenameLabel("Worktree"),
        icon: "pencil",
        disabled: blocked,
        callback: () => {
          renameTarget = { kind: "worktree", path: worktree.path, name: displayName(worktree) };
        },
      },
      { kind: "separator" },
      {
        name: sidebarOpensViewLabel("Delete Worktree"),
        icon: "trash",
        danger: true,
        disabled: !canDelete,
        callback: () => {
          deleteWorktreeTarget = { path: worktree.path, name: displayName(worktree) };
        },
      },
    );
    sheet = { title: displayName(worktree), subtitle: worktree.path, actions };
  }

  function openConversationSheet(session: ACPConversationSummary) {
    const title = session.title || "Untitled conversation";
    const canDelete = !session.sessionId || sidebar.canDeleteSession(session);
    const actions: MobileSheetItem[] = [
      {
        name: sidebarRenameLabel("Conversation"),
        icon: "pencil",
        callback: () => {
          renameTarget = { kind: "conversation", id: session.id, name: title };
        },
      },
      acpLogCaptureMenuAction(
        acpConnectionPool?.debug?.capture,
        {
          agentServer: sidebar.getSessionAgentServer(session),
          conversationId: session.id,
          sessionId: session.sessionId,
        },
        (target) => (acpLogCaptureTarget = target),
      ),
      { kind: "separator" },
      {
        name: "Archive Conversation",
        icon: "archive",
        callback: () => archiveConversation(session),
      },
      {
        name: sidebarOpensViewLabel("Delete Conversation"),
        icon: "trash",
        danger: true,
        disabled: !canDelete,
        callback: () => {
          deleteConversationTarget = { session, name: title };
        },
      },
    ];
    sheet = {
      title,
      subtitle: sidebar.getAgentName(sidebar.getSessionAgentServer(session)),
      actions,
    };
  }

  function isActiveConversation(session: ACPConversationSummary): boolean {
    return (
      activeConversationId === session.id ||
      sidebar.isSelectedSession(
        session.sessionId,
        session.id,
        sidebar.getSessionAgentServer(session),
      )
    );
  }

  // Unlike desktop, no replacement conversation is selected after archive or
  // delete: on mobile the list view is already showing, so just clear the
  // active conversation instead of loading another session in the background.
  async function archiveConversation(session: ACPConversationSummary) {
    const agentServer = sidebar.getSessionAgentServer(session);
    const shouldInterrupt = sidebar.shouldInterruptSelectedSession(session.sessionId, agentServer);
    const wasActive = isActiveConversation(session) || shouldInterrupt;
    if (shouldInterrupt) {
      await sidebar.cancelActiveSession();
    }
    await conversations.archiveSession(session.cwd, session.sessionId, agentServer, session.id);
    if (wasActive) onActiveConversationIdChange(null);
  }

  async function deleteConversation(session: ACPConversationSummary) {
    const agentServer = sidebar.getSessionAgentServer(session);
    const shouldInterrupt = sidebar.shouldInterruptSelectedSession(session.sessionId, agentServer);
    const wasActive = isActiveConversation(session) || shouldInterrupt;
    if (shouldInterrupt) {
      await sidebar.cancelActiveSession();
    }
    await conversations.deleteConversation(session.id, session.sessionId, agentServer);
    if (wasActive) onActiveConversationIdChange(null);
  }

  async function removeWorktree(path: string) {
    const hadActiveConversation = sessionsFor(path).some(isActiveConversation);
    try {
      projects.setWorktreeBusy(path, "tearing_down");
      await worktrees.removeWorktree(path, (kind) => projects.setWorktreeBusy(path, kind));
      await projects.refresh();
      await conversations.refresh();
      if (hadActiveConversation) onActiveConversationIdChange(null);
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to delete worktree" }),
        InfoMessageType.error,
      );
    } finally {
      projects.clearWorktreeBusy(path);
    }
  }

  async function removeProject(path: string) {
    await projects.removeProject(path);
    await worktrees.closeProject(path);
    await conversations.refresh();
  }

  // Simplified from the desktop's handleAddWorktree: no undo countdown and no
  // mid-creation abort on mobile; the first conversation is created after the
  // worktree (and its setup script) is ready rather than concurrently.
  async function addWorktree(project: ACPNavProject) {
    let pendingPath = "";
    try {
      const prepared = await worktrees.prepareWorktree(project.path);
      if (!prepared) return;
      pendingPath = projects.addPendingWorktree(prepared, "creating");
      const created = await worktrees.createWorktree(project.path, prepared, (kind) =>
        projects.setWorktreeBusy(pendingPath, kind),
      );
      await projects.refresh();
      await conversations.refresh();
      if (created) await sidebar.newConversation(created.path);
    } catch (error) {
      if (pendingPath) {
        try {
          await worktrees.discardPreparedWorktree(pendingPath);
        } catch (discardError) {
          console.error("Failed to discard prepared worktree", discardError);
        }
        await projects.refresh();
        await conversations.refresh();
      }
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to create worktree" }),
        InfoMessageType.error,
      );
    } finally {
      if (pendingPath) projects.clearWorktreeBusy(pendingPath);
    }
  }

  // iOS Safari blocks window.open outside the synchronous part of a tap
  // gesture, so open a stub window first and point it at the URL once the
  // helper resolves the GitHub links.
  function openGithubUrl(path: string, pick: (links: GitHubLinksOutput) => string) {
    const stub = window.open("", "_blank");
    void github
      .links(path)
      .then((links) => {
        const url = links.supported ? pick(links) : "";
        if (!url) {
          stub?.close();
          rpc.showInfoMessage("This folder has no GitHub remote.", InfoMessageType.info);
          return;
        }
        if (stub) {
          stub.location.href = url;
        } else {
          window.open(url, "_blank", "noopener");
        }
      })
      .catch((error) => {
        stub?.close();
        rpc.showInfoMessage(
          formatError(error, { prefix: "Failed to resolve GitHub link" }),
          InfoMessageType.error,
        );
      });
  }

  async function submitRename(value: string) {
    const target = renameTarget;
    if (!target) return;
    renameTarget = null;
    try {
      if (target.kind === "conversation") {
        await conversations.renameConversation(target.id, value);
      } else {
        await projects.renameProject(target.path, value);
      }
    } catch (error) {
      console.error("Failed to rename ACP sidebar item", error);
    }
  }
</script>

{#snippet conversationRows(workspaceSessions: ACPConversationSummary[], indented: boolean)}
  {#each workspaceSessions as session (session.agentServer + session.id)}
    {@const row = sidebar.rowState(session)}
    {@const title = session.title || "Untitled conversation"}
    {@const isDraft = session.sessionId === null}
    <div
      class={[
        "mobile-touch-row flex items-center",
        indented ? "pl-9" : "pl-4",
        row.selected ? "bg-psx-menu-hover-background" : "",
      ]}
      use:longPress={() => openConversationSheet(session)}
    >
      <button
        type="button"
        data-testid="acp-conversation-row"
        class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] py-3 text-left focus-visible:outline-2"
        aria-label={`${title} - ${row.agentName}`}
        onclick={() => onOpenConversation(session)}
      >
        <span class="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <RegistryAgentIcon iconUrl={row.iconUrl} size={16} class={row.iconClass} />
        </span>
        <span
          class={[
            "flex min-w-0 flex-1 items-center gap-1 text-[15px]/[20px]",
            row.unread ? "font-semibold" : "",
            isDraft ? "text-psx-foreground-secondary" : "text-psx-foreground-primary",
            row.titleClass,
          ]}
        >
          {#if isDraft}
            <Icon name="pencil" size={12} class="shrink-0" aria-hidden="true" />
          {/if}
          <span class="min-w-0 truncate">{title}</span>
        </span>
      </button>
      <span class="flex shrink-0 items-center justify-end pl-2">
        {#if row.waitingForUser}
          <span
            class="bg-psx-warning-foreground block size-[7px] rounded-full"
            role="img"
            aria-label="Waiting for your input"
          ></span>
        {:else if row.working}
          <span class="text-psx-info-foreground">
            <StreamingSequenceLoader size={16} ariaLabel="Conversation responding" />
          </span>
        {:else if row.unread}
          <span
            class="block size-[7px] rounded-full"
            style="background: #3794ff;"
            role="img"
            aria-label="Unread conversation"
          ></span>
        {:else if session.updatedAt}
          <span class="text-psx-foreground-secondary text-[12px]">
            {formatRelativeTimeWithoutAgo(session.updatedAt)}
          </span>
        {/if}
      </span>
      <button
        type="button"
        class="text-psx-foreground-tertiary outline-hidden active:bg-psx-menu-hover-background focus-visible:outline-psx-focus mx-1 flex size-9 shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-2"
        aria-label={`Actions for ${title}`}
        onclick={(event) => {
          event.stopPropagation();
          openConversationSheet(session);
        }}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  {/each}
{/snippet}

<div class="flex flex-col" aria-label="Projects and conversations">
  {#if projects.refreshState.status === "failure"}
    <div class="text-psx-foreground-secondary px-5 py-8 text-center text-sm">
      {formatError(projects.refreshState.error, { prefix: "Failed to load projects" })}
    </div>
  {:else if isEmpty && isLoading}
    <div class="flex justify-center py-10">
      <Spinner aria-label="Loading conversations" size={20} />
    </div>
  {:else if isEmpty}
    <div class="text-psx-foreground-secondary px-5 py-8 text-center text-sm">
      No conversations yet. Start one here or on your desktop — they stay in sync.
    </div>
  {:else}
    {#if chatSessions.length > 0}
      <section aria-label="Chats" class="border-psx-border border-b pb-1">
        <div class="mobile-touch-row flex items-center">
          <button
            type="button"
            class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] py-3 pl-4 text-left focus-visible:outline-2"
            aria-expanded={!chatsCollapsed}
            aria-label={chatsCollapsed ? "Expand Chats" : "Collapse Chats"}
            onclick={() => (chatsCollapsed = !chatsCollapsed)}
          >
            <span
              class="text-psx-foreground-primary min-w-0 truncate text-[15px]/[20px] font-medium"
            >
              Chats
            </span>
            <span
              class={[
                "text-psx-foreground-tertiary inline-flex shrink-0 transition-transform",
                chatsCollapsed ? "-rotate-90" : "",
              ]}
              aria-hidden="true"
            >
              <Icon name="chevron" size={14} />
            </span>
          </button>
        </div>
        {#if !chatsCollapsed}
          {@render conversationRows(chatSessions, false)}
        {/if}
      </section>
    {/if}

    {#each rootProjects as project (project.path)}
      {@const projectName = displayName(project)}
      {@const projectSessions = sessionsFor(project.path)}
      {@const projectWorktrees = worktreesFor(project.path)}
      {@const expanded = !project.collapsed}
      <section aria-label={projectName} class="border-psx-border border-b pb-1">
        <div
          class="mobile-touch-row flex items-center"
          use:longPress={() => openProjectSheet(project)}
        >
          <button
            type="button"
            class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] py-3 pl-4 text-left focus-visible:outline-2"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${projectName}` : `Expand ${projectName}`}
            onclick={() => toggleCollapsed(project)}
          >
            <Icon
              name={expanded ? "folder-open" : "folder-closed"}
              size={16}
              class="text-psx-icon shrink-0"
            />
            <span
              class="text-psx-foreground-primary min-w-0 truncate text-[15px]/[20px] font-medium"
            >
              {projectName}
            </span>
            <span
              class={[
                "text-psx-foreground-tertiary inline-flex shrink-0 transition-transform",
                expanded ? "" : "-rotate-90",
              ]}
              aria-hidden="true"
            >
              <Icon name="chevron" size={14} />
            </span>
          </button>
          <button
            type="button"
            class="text-psx-foreground-tertiary outline-hidden active:bg-psx-menu-hover-background focus-visible:outline-psx-focus mx-1 flex size-9 shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-2"
            aria-label={`Actions for ${projectName}`}
            onclick={() => openProjectSheet(project)}
          >
            <Icon name="more" size={16} />
          </button>
        </div>

        {#if expanded}
          {@render conversationRows(projectSessions, false)}
          {#if projectSessions.length === 0 && projectWorktrees.length === 0}
            <div class="text-psx-foreground-tertiary pb-2 pl-11 pr-4 text-[13px]">
              No conversations
            </div>
          {/if}

          {#each projectWorktrees as worktree (worktree.path)}
            {@const worktreeName = displayName(worktree)}
            {@const worktreeSessions = sessionsFor(worktree.path)}
            {@const worktreeExpanded = worktree.collapsed !== true}
            {@const busyLabel = worktree.busy ? worktreeBusyLabel(worktree.busy) : ""}
            <div
              class={[
                "mobile-touch-row flex items-center pl-4",
                worktree.deleteRequested === true ? "opacity-60" : "",
              ]}
              use:longPress={() => openWorktreeSheet(worktree)}
            >
              <button
                type="button"
                class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] py-3 text-left focus-visible:outline-2"
                aria-expanded={worktreeExpanded}
                aria-label={worktreeExpanded
                  ? `Collapse ${worktreeName}`
                  : `Expand ${worktreeName}`}
                onclick={() => toggleCollapsed(worktree)}
              >
                <span
                  class="text-psx-icon inline-flex size-4 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  {#if worktree.busy !== undefined}
                    <Spinner aria-hidden size={12} />
                  {:else}
                    <Icon name="git-branch" size={14} />
                  {/if}
                </span>
                <span class="text-psx-foreground-primary min-w-0 truncate text-[15px]/[20px]">
                  {worktreeName}
                </span>
                {#if busyLabel}
                  <span class="text-psx-foreground-tertiary shrink-0 text-[12px]">{busyLabel}</span>
                {/if}
                {#if worktreeSessions.length > 0}
                  <span
                    class={[
                      "text-psx-foreground-tertiary inline-flex shrink-0 transition-transform",
                      worktreeExpanded ? "" : "-rotate-90",
                    ]}
                    aria-hidden="true"
                  >
                    <Icon name="chevron" size={14} />
                  </span>
                {/if}
              </button>
              <button
                type="button"
                class="text-psx-foreground-tertiary outline-hidden active:bg-psx-menu-hover-background focus-visible:outline-psx-focus mx-1 flex size-9 shrink-0 items-center justify-center rounded-[8px] focus-visible:outline-2"
                aria-label={`Actions for ${worktreeName}`}
                onclick={() => openWorktreeSheet(worktree)}
              >
                <Icon name="more" size={16} />
              </button>
            </div>
            {#if worktreeExpanded}
              {@render conversationRows(worktreeSessions, true)}
            {/if}
          {/each}
        {/if}
      </section>
    {/each}
  {/if}
</div>

{#if sheet}
  <MobileActionSheet
    title={sheet.title}
    subtitle={sheet.subtitle}
    actions={sheet.actions}
    onClose={() => (sheet = null)}
  />
{/if}

{#if renameTarget}
  <RenameDialog
    title={`Rename ${renameTarget.kind}`}
    label="Name"
    value={renameTarget.name}
    onCancel={() => (renameTarget = null)}
    onRename={submitRename}
  />
{/if}

{#if acpLogCaptureTarget}
  <ACPLogCaptureConfirmation
    target={acpLogCaptureTarget}
    onClose={() => (acpLogCaptureTarget = null)}
  />
{/if}

{#if removeProjectTarget}
  <ConfirmationDialog
    destructive
    title="Delete project?"
    description={`Delete ${removeProjectTarget.name} from Camber. Existing files on disk will not be deleted.`}
    confirmLabel="Delete Project"
    onCancel={() => (removeProjectTarget = null)}
    onConfirm={async () => {
      const target = removeProjectTarget;
      if (!target) return;
      await removeProject(target.path);
      removeProjectTarget = null;
    }}
  />
{/if}

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

{#if deleteConversationTarget}
  <ConfirmationDialog
    destructive
    title="Delete conversation?"
    description={`Delete ${deleteConversationTarget.name}. This removes the conversation and cannot be undone.`}
    confirmLabel="Delete Conversation"
    onCancel={() => (deleteConversationTarget = null)}
    onConfirm={async () => {
      const target = deleteConversationTarget;
      if (!target) return;
      await deleteConversation(target.session);
      deleteConversationTarget = null;
    }}
  />
{/if}

<style>
  /* Long-pressable rows: keep vertical scrolling native but disable text
     selection and the iOS press-and-hold callout, which would fight the
     long-press menu. */
  .mobile-touch-row {
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
</style>
