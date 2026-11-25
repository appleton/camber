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

/**
 * Whether the prompt holds nothing but a slash command being typed: empty (the
 * menu opened from the slash button), a lone "/", or "/partial-name". Not when
 * the command follows other text or carries arguments.
 */
export function isSlashCommandOnlyPrompt(value: string): boolean {
  return /^(?:\/\S*)?$/.test(value.trim());
}
