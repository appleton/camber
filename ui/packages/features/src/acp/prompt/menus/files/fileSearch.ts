import { camberSearchFiles } from "@camber/helperapi";
import type { SearchFilesOutput } from "@camber/helperapi/schemas";
import { classifyQuery, type ClassifiedQuery } from "@camber/lib/path-query";
import type { AppState } from "../../../hostAdapter";
import { acpWorkspaceFolders } from "../../../workspaceScope";
import { isWindowsOperatingSystem } from "./pathRewrites";

export interface SearchProjectFilesOptions {
  query: string;
  appState: Pick<AppState, "environment" | "isHelperSupported" | "workspaces">;
  activeWorkspaceCwd?: string | null;
  projects?: Array<{ path: string }>;
  desktopWorkspaceScope?: "project" | "cwd";
  excludeOpenFilesOutsideWorkspaces?: boolean;
}

export type SearchProjectFilesResult =
  | { kind: "ok"; response: SearchFilesOutput }
  | { kind: "helperUnsupported" };

export function classifyFileSearchQuery(query: string, operatingSystem?: string): ClassifiedQuery {
  return classifyQuery(query, {
    isWindows: isWindowsOperatingSystem(operatingSystem),
  });
}

export async function searchProjectFiles({
  query,
  appState,
  activeWorkspaceCwd = null,
  projects = [],
  desktopWorkspaceScope = "project",
  excludeOpenFilesOutsideWorkspaces = false,
}: SearchProjectFilesOptions): Promise<SearchProjectFilesResult> {
  if (!appState.isHelperSupported) {
    return { kind: "helperUnsupported" };
  }

  const workspaceRoot = searchWorkspaceRoot(
    appState,
    activeWorkspaceCwd,
    projects,
    desktopWorkspaceScope,
  );
  if (
    appState.environment.assistantHost === "desktop" &&
    desktopWorkspaceScope === "cwd" &&
    !workspaceRoot
  ) {
    return { kind: "ok", response: { files: [] } };
  }

  const searchFilesParams = {
    query,
    workspaces: acpWorkspaceFolders(appState, workspaceRoot),
    excludeOpenFilesOutsideWorkspaces,
  };
  const response = await camberSearchFiles(searchFilesParams);

  return {
    kind: "ok",
    response:
      appState.environment.assistantHost === "desktop" &&
      desktopWorkspaceScope === "cwd" &&
      workspaceRoot
        ? filterSearchResponseToWorkspace(response, workspaceRoot)
        : response,
  };
}

export function acpDesktopWorkspaceRoot(
  appState: Pick<AppState, "environment">,
  cwd: string | null | undefined,
  projects: Array<{ path: string }> = [],
): string | null {
  if (!cwd) return null;
  if (appState.environment.assistantHost !== "desktop") return cwd;

  const normalizedCwd = normalizeWorkspacePath(cwd);
  const project = projects
    .filter((candidate) => pathContains(candidate.path, normalizedCwd))
    .sort(
      (left, right) =>
        normalizeWorkspacePath(right.path).length - normalizeWorkspacePath(left.path).length,
    )
    .at(0);
  return project?.path ?? cwd;
}

function searchWorkspaceRoot(
  appState: Pick<AppState, "environment">,
  cwd: string | null | undefined,
  projects: Array<{ path: string }>,
  desktopWorkspaceScope: "project" | "cwd",
): string | null {
  if (desktopWorkspaceScope === "cwd") return cwd?.trim() || null;
  return acpDesktopWorkspaceRoot(appState, cwd, projects);
}

function filterSearchResponseToWorkspace(
  response: SearchFilesOutput,
  workspaceRoot: string,
): SearchFilesOutput {
  return {
    ...response,
    files: response.files.filter((file) => pathContains(workspaceRoot, file.path)),
    controls: response.controls?.filter(
      (control) => !control.path || pathContains(workspaceRoot, control.path),
    ),
  };
}

export function pathContains(parentPath: string, path: string): boolean {
  const parent = normalizeWorkspacePath(parentPath);
  const child = normalizeWorkspacePath(path);
  if (!parent || !child) return false;
  return child === parent || child.startsWith(`${parent}/`);
}

export function normalizeWorkspacePath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, "");
  }
  if (/^[A-Z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}
