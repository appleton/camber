import { basename } from "@camber/lib/path";
import type { WorkspaceFolder } from "@camber/rpc";
import type { AppState } from "./hostAdapter";
import type { ACPNavProject } from "./navTypes";
import { workspacePathFitsWorkspaceFolders } from "./workspacePaths";

export const ACP_IDE_WORKSPACE_PATH = "IDE";
export const ACP_CHAT_WORKSPACE_PATH = "CHAT";

export function acpWorkspaceFolders(
  appState: Pick<AppState, "environment" | "workspaces">,
  desktopPath?: string | null,
): WorkspaceFolder[] {
  if (appState.environment.assistantHost !== "desktop") {
    return appState.workspaces;
  }

  const path = desktopPath?.trim();
  return path ? [workspaceFolderFromPath(path)] : [];
}

export function acpProtocolCwd(workspaceFolders: WorkspaceFolder[], fallback = "/"): string {
  return workspaceFolders[0]?.path || fallback || "/";
}

// The cwd a conversation must be reopened with. Agents key a stored session by the
// cwd it was created in, so session/load has to carry that same cwd back or the
// session cannot be found. The open workspace folder is only a fallback for
// conversations that never recorded a cwd of their own.
export function acpSessionLoadCwd(
  sessionCwd: string | null | undefined,
  workspaceFolders: WorkspaceFolder[],
): string {
  // Trim only to recognise a blank cwd. Surrounding spaces are legal in a POSIX path,
  // so a trimmed cwd is a different key than the one the session was stored under.
  return sessionCwd?.trim() ? sessionCwd : acpProtocolCwd(workspaceFolders);
}

export function acpWorkspacePath(
  appState: Pick<AppState, "environment">,
  workspaceFolders: WorkspaceFolder[],
  fallbackPath: string,
): string {
  return appState.environment.assistantHost === "desktop"
    ? acpProtocolCwd(workspaceFolders, fallbackPath)
    : ACP_IDE_WORKSPACE_PATH;
}

export function acpSessionWorkspacePath(
  appState: Pick<AppState, "environment">,
  workspaceFolders: WorkspaceFolder[],
  fallbackPath: string,
  isChat: boolean,
): string {
  return isChat
    ? ACP_CHAT_WORKSPACE_PATH
    : acpWorkspacePath(appState, workspaceFolders, fallbackPath);
}

export function acpWorkingDirectories(
  workspaceFolders: WorkspaceFolder[],
  fallback: string,
): string[] {
  const paths = workspaceFolders.map((folder) => folder.path).filter(Boolean);
  if (paths.length > 0) return paths;
  return fallback ? [fallback] : [];
}

export function acpWorkspaceProjectFolders(
  projects: ACPNavProject[],
  workspaceFolders: WorkspaceFolder[],
): WorkspaceFolder[] {
  const projectFolders = projects
    .filter((project) => workspacePathFitsWorkspaceFolders(project.path, workspaceFolders))
    .map((project) => workspaceFolderFromPath(project.path, project.nickname || project.name));

  return projectFolders.length > 0 ? projectFolders : workspaceFolders;
}

export function workspaceFolderFromPath(path: string, name?: string): WorkspaceFolder {
  return {
    path,
    name: name || basename(path) || path,
    index: -1,
  };
}
