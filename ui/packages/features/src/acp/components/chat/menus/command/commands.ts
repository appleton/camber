export enum AcpSlashCommand {
  new = "new",
  dump = "dump",
  load = "load",
  plan = "plan",
  secrets = "secrets",
  archive = "archive",
  deleteWorktree = "delete-worktree",
}

/** The command name when `value` is a lone slash command with no arguments. */
export function bareSlashCommand(value: string): string | null {
  const match = /^\/(\S+)$/.exec(value.trim());
  return match?.[1] ?? null;
}
