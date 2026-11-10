import { EnrichedContextKind, EnrichedContextSource, type PromptContextFacet } from "@camber/rpc";
import * as vscode from "vscode";
import { System } from "../system";
import type { GitExtension } from "./gitExtension";

export async function getGitBranchNamesContext(): Promise<PromptContextFacet | undefined> {
  const repositories = getWorkspaceGitRepositories();
  if (repositories.length === 0) return undefined;
  const branchNames = [
    ...new Set(
      repositories.map((r) => r.state.HEAD?.name).filter((name) => name !== undefined),
    ).keys(),
  ];
  if (branchNames.length > 0) {
    return {
      description: "Git branch name",
      items: branchNames.map((content) => ({ content })),
      kind: EnrichedContextKind.branchName,
      mime_type: "text/plain",
      source: EnrichedContextSource.branch,
    };
  } else {
    return undefined;
  }
}

export async function getGitBranchCommitMessagesContext(
  system: System,
): Promise<PromptContextFacet | undefined> {
  const repositories = getWorkspaceGitRepositories();
  if (repositories.length === 0) return undefined;
  const commits = (
    await Promise.all(
      repositories.map(async (r) => {
        try {
          const repoCommits = await r.log({ range: "origin/HEAD..", maxEntries: 10 });
          return repoCommits.map((commit) => commit.message);
        } catch (error) {
          system.telemetry.reportError(error);
          return [];
        }
      }),
    )
  ).flat();
  if (commits.length > 0) {
    return {
      description: "Commits on branch diverging from main branch",
      items: commits.map((content) => ({ content })),
      kind: EnrichedContextKind.branchCommits,
      mime_type: "text/plain",
      source: EnrichedContextSource.branch,
    };
  } else {
    return undefined;
  }
}

function getWorkspaceGitRepositories() {
  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  if (!gitExtension) {
    return [];
  }
  try {
    const gitAPI = gitExtension.getAPI(1);
    return gitAPI.repositories;
  } catch (_e) {
    return [];
  }
}
