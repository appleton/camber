import {
  camberAcpNavGetProjectSettings,
  camberAcpNavList,
  camberAcpNavRemoveProject,
  camberAcpNavRenameProject,
  camberAcpNavReorderProjects,
  camberAcpNavReorderWorktrees,
  camberAcpNavSetProjectCollapsed,
  camberAcpNavSetProjectSettings,
  camberAcpNavUpsertProject,
} from "@camber/helperapi";
import { fromPromise, success, waiting, type AsyncState } from "@camber/lib/async-state";
import { createContext } from "svelte";
import { normalizeACPError, type ACPRequestError } from "../errors";
import {
  ACP_DESKTOP_PROJECTS_EVENT,
  type ACPNavProject,
  type ACPNavProjectSettings,
  type ACPProjectsState,
  type WorktreeBusyKind,
} from "../navTypes";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };
interface ACPRefreshOptions {
  showLoading?: boolean;
}

export type ACPProjectRepository = NoSetters<ACPProjectRepositoryWriter>;

export class ACPProjectRepositoryWriter {
  // Transient worktree state is kept entirely in memory: the backend never
  // returns `busy`, so any UI state we want to show is layered on top of the
  // server snapshot in mergeTransientWorktrees(). We cache the latest
  // unmerged server snapshot so that overlay changes re-merge from a clean
  // baseline rather than re-merging an already-decorated list.
  private serverProjects: ACPNavProject[] = [];
  private pendingWorktrees = new Map<string, ACPNavProject>();
  private busyWorktrees = new Map<string, WorktreeBusyKind>();
  private deleteRequested = new Set<string>();

  refreshState = $state<AsyncState<ACPNavProject[], ACPRequestError>>(waiting);
  emitter = new EventTarget();

  // The last successfully merged snapshot. A default refresh() flips
  // refreshState to "loading" before the new list arrives; without this,
  // `projects` would transiently report [] mid-reload, which reads as "no
  // projects" to consumers (e.g. the desktop chat pane swaps the transcript
  // for the empty state and back, resetting scroll). Keeping the last list
  // visible during a reload avoids that flicker.
  private lastLoadedProjects = $state<ACPNavProject[]>([]);

  readonly projects = $derived(
    this.refreshState.status === "success"
      ? this.refreshState.value
      : this.refreshState.status === "loading"
        ? this.lastLoadedProjects
        : [],
  );

  async refresh({ showLoading = true }: ACPRefreshOptions = {}): Promise<void> {
    const result = await fromPromise(
      async () => {
        const state = await camberAcpNavList({});
        return state.projects ?? [];
      },
      (state) => {
        if (!showLoading && state.status === "loading") return;
        if (state.status === "success") {
          this.applyProjects(state.value);
        } else {
          this.refreshState = state;
        }
      },
      { mapError: normalizeACPError },
    );

    if (result.status === "success") {
      this.emitState();
    }
  }

  async upsertProject(project: {
    path: string;
    name: string;
    isWorktree?: boolean;
    parentPath?: string;
  }): Promise<void> {
    if (!project.path) return;
    await camberAcpNavUpsertProject({
      path: project.path,
      name: project.name,
      isWorktree: project.isWorktree ?? false,
      parentPath: project.parentPath,
    });
    await this.refresh();
  }

  async removeProject(path: string): Promise<void> {
    this.applyProjects((await camberAcpNavRemoveProject({ path })).projects ?? []);
  }

  async renameProject(path: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!path || !trimmed) return;
    this.applyProjects((await camberAcpNavRenameProject({ path, name: trimmed })).projects ?? []);
  }

  async setProjectCollapsed(path: string, collapsed: boolean): Promise<void> {
    if (!path) return;
    this.applyProjects((await camberAcpNavSetProjectCollapsed({ path, collapsed })).projects ?? []);
  }

  async reorderProjects(paths: string[]): Promise<void> {
    this.applyProjects((await camberAcpNavReorderProjects({ paths })).projects ?? []);
  }

  async reorderWorktrees(parentPath: string, paths: string[]): Promise<void> {
    if (!parentPath) return;
    this.applyProjects((await camberAcpNavReorderWorktrees({ parentPath, paths })).projects ?? []);
  }

  async getProjectSettings(path: string): Promise<ACPNavProjectSettings | undefined> {
    if (!path) return undefined;
    return (await camberAcpNavGetProjectSettings({ path })).settings;
  }

  async setProjectSettings(
    settings: ACPNavProjectSettings,
  ): Promise<ACPNavProjectSettings | undefined> {
    if (!settings.path) return undefined;
    const updated = (
      await camberAcpNavSetProjectSettings({
        path: settings.path,
        setupScript: settings.setupScript,
        teardownScript: settings.teardownScript,
        userPrompt: settings.userPrompt,
      })
    ).settings;
    if (!updated) return undefined;

    this.applyProjects(
      this.serverProjects.map((project) =>
        project.path === updated.path
          ? {
              ...project,
              setupScript: updated.setupScript,
              teardownScript: updated.teardownScript,
              userPrompt: updated.userPrompt,
            }
          : project,
      ),
    );
    return updated;
  }

  replaceProjects(projects: ACPNavProject[]): void {
    this.applyProjects(projects);
  }

  applyNavState(state: { projects?: ACPNavProject[] | null }): void {
    this.applyProjects(state.projects ?? []);
  }

  // Adds a placeholder worktree row that is rendered until the matching
  // server-side row appears. Used between prepareWorktree and createWorktree.
  addPendingWorktree(worktree: ACPNavProject, kind: WorktreeBusyKind = "creating"): string {
    this.pendingWorktrees.set(worktree.path, worktree);
    this.busyWorktrees.set(worktree.path, kind);
    this.reapplyOverlays();
    return worktree.path;
  }

  setWorktreeBusy(path: string, kind: WorktreeBusyKind): void {
    this.busyWorktrees.set(path, kind);
    this.reapplyOverlays();
  }

  getWorktreeBusy(path: string): WorktreeBusyKind | undefined {
    return this.busyWorktrees.get(path);
  }

  requestDelete(path: string): void {
    this.deleteRequested.add(path);
    this.reapplyOverlays();
  }

  isDeleteRequested(path: string): boolean {
    return this.deleteRequested.has(path);
  }

  clearWorktreeBusy(path: string): void {
    this.busyWorktrees.delete(path);
    this.pendingWorktrees.delete(path);
    this.deleteRequested.delete(path);
    this.reapplyOverlays();
  }

  private reapplyOverlays(): void {
    this.applyProjects(this.serverProjects);
  }

  publicAPI(): ACPProjectRepository {
    return this as ACPProjectRepository;
  }

  // applyProjects accepts the canonical server-shape snapshot (no overlays).
  // Caching it lets later overlay changes re-merge without sneaking in
  // already-merged data.
  private applyProjects(projects: ACPNavProject[]): void {
    this.serverProjects = projects;
    const merged = this.mergeTransientWorktrees(projects);
    this.lastLoadedProjects = merged;
    this.refreshState = success(merged);
    this.emitState();
  }

  // Overlays in-memory transient state (busy kind, pending placeholders) onto
  // the latest snapshot from the server. The merge is the single source of
  // truth for the `busy` field — any inbound `busy` on a project is stripped
  // unless the path is currently tracked in busyWorktrees.
  private mergeTransientWorktrees(projects: ACPNavProject[]): ACPNavProject[] {
    const byPath = new Map(projects.map((project) => [project.path, project]));
    for (const [path, project] of this.pendingWorktrees) {
      if (!byPath.has(path)) {
        byPath.set(path, project);
      }
    }
    const merged: ACPNavProject[] = [];
    for (const project of byPath.values()) {
      const { busy: _dropBusy, deleteRequested: _dropDeleteRequested, ...baseProject } = project;
      const busy = this.busyWorktrees.get(project.path);
      const requestedDelete = this.deleteRequested.has(project.path);
      if (busy || requestedDelete) {
        merged.push({
          ...baseProject,
          ...(busy ? { busy } : {}),
          ...(requestedDelete ? { deleteRequested: true } : {}),
        });
      } else {
        merged.push(baseProject);
      }
    }
    return merged;
  }

  private emitState(): void {
    this.emitter.dispatchEvent(
      new CustomEvent<ACPProjectsState>(ACP_DESKTOP_PROJECTS_EVENT, {
        detail: { projects: this.projects },
      }),
    );
  }
}

const [getACPProjectContext, setACPProjectRepositoryContext] =
  createContext<ACPProjectRepository>();

export { getACPProjectContext };

export function setACPProjectContext(): ACPProjectRepositoryWriter {
  const repo = new ACPProjectRepositoryWriter();
  setACPProjectRepositoryContext(repo.publicAPI());
  return repo;
}

export { setACPProjectRepositoryContext as _setACPProjectContextForTests };

export function getACPProjectRepo(): ACPProjectRepository {
  return getACPProjectContext();
}
