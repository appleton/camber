import { EnrichedContextKind, EnrichedContextSource, type PromptContextFacet } from "@camber/rpc";

const MAX_LABEL = 72;

export function truncate(text: string, max = MAX_LABEL): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

export function getRepositoryName(cwd: string): string | null {
  const parts = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const worktreeIdx = parts.findIndex((s) => s.toLowerCase() === ".worktrees");
  const name = worktreeIdx > 0 ? parts[worktreeIdx - 1] : parts.at(-1);
  if (!name || name === "." || name === ".." || name.endsWith(":")) return null;
  return name;
}

export function extractBranch(facets: PromptContextFacet[]): string | null {
  if (!Array.isArray(facets)) return null;
  let fallback: string | null = null;
  for (const facet of facets) {
    if (facet.source !== EnrichedContextSource.branch) continue;
    for (const item of facet.items ?? []) {
      const content = item.content?.trim();
      if (!content) continue;
      if (facet.kind === EnrichedContextKind.branchName) return content;
      fallback ??= content;
    }
  }
  return fallback;
}

export function isValidUsage(usage: {
  used: number | null;
  max: number | null;
}): usage is { used: number; max: number } {
  return (
    typeof usage.used === "number" &&
    Number.isFinite(usage.used) &&
    typeof usage.max === "number" &&
    Number.isFinite(usage.max) &&
    usage.max > 0
  );
}
