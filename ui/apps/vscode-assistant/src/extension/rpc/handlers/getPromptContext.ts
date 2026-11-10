import { type PromptContextFacet } from "@camber/rpc";
import {
  getGitBranchCommitMessagesContext,
  getGitBranchNamesContext,
} from "../../contextproviders/git";
import { System } from "../../system";

type Generator = (system: System) => Promise<PromptContextFacet | undefined>;

const branchProviders: Generator[] = [getGitBranchNamesContext, getGitBranchCommitMessagesContext];

export async function getPromptContext(system: System): Promise<Array<PromptContextFacet>> {
  return (await Promise.all(branchProviders.map((provider) => provider(system)))).flatMap(
    (result) => (result && result.items ? result : []),
  );
}
