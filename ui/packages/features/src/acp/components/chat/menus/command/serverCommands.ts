import type { AvailableCommand } from "@agentclientprotocol/sdk";

const commandNameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export interface ServerCommandEntry {
  command: AvailableCommand;
  key: string;
}

export function isSkillCommand(command: AvailableCommand): boolean {
  return (
    command.name.startsWith("$") || command._meta?.["camber/slash_command_category"] === "skill"
  );
}

export interface InstalledSkill {
  name: string;
  description: string;
}

export function installedSkillsAsCommands(
  skills: ReadonlyArray<InstalledSkill>,
): AvailableCommand[] {
  return skills.map((skill) => ({
    name: skill.name.startsWith("$") ? skill.name : `$${skill.name}`,
    description: skill.description,
    _meta: { "camber/slash_command_category": "skill" },
  }));
}

// Agents that don't mark skill commands (e.g. claude-agent-acp) publish none
// that isSkillCommand recognizes, and the helper scan only covers directories
// it knows about — so neither source alone is complete. Merge them, letting a
// published entry win a name collision since its description is authoritative.
export function resolvedSkillCommands(
  availableCommands: ReadonlyArray<AvailableCommand>,
  installedSkills: ReadonlyArray<AvailableCommand>,
): AvailableCommand[] {
  const publishedSkills = availableCommands.filter(isSkillCommand);
  const publishedNames = new Set(
    publishedSkills.map((command) => normalizedSkillName(command.name)),
  );
  return [
    ...publishedSkills,
    ...installedSkills.filter((command) => !publishedNames.has(normalizedSkillName(command.name))),
  ];
}

function normalizedSkillName(name: string): string {
  return (name.startsWith("$") ? name.slice(1) : name).toLocaleLowerCase();
}

// Pool established $name as the skill invocation convention in prompt text
// (forge #44905); agents may still publish skill names without the prefix.
export function skillInvocation(name: string): string {
  return name.startsWith("$") ? name : `$${name}`;
}

export function resolvedSlashCommandNames(
  availableCommands: ReadonlyArray<AvailableCommand>,
  installedSkills: ReadonlyArray<AvailableCommand>,
): { skills: string[]; commands: string[] } {
  return {
    skills: resolvedSkillCommands(availableCommands, installedSkills).map((skill) =>
      skillInvocation(skill.name),
    ),
    commands: availableCommands
      .filter((command) => !isSkillCommand(command))
      .map(({ name }) => name),
  };
}

const FILTERED_COMMAND_LIMIT = 30;
const sortedEntriesCache = new WeakMap<ReadonlyArray<AvailableCommand>, ServerCommandEntry[]>();

const WORD_BOUNDARY_PATTERN = /[\s._/-]+/;

function acronym(text: string): string {
  return text
    .split(WORD_BOUNDARY_PATTERN)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
}

function isSubsequence(query: string, text: string): boolean {
  let queryIndex = 0;
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function hasWordPrefix(query: string, text: string): boolean {
  return text
    .split(WORD_BOUNDARY_PATTERN)
    .filter(Boolean)
    .some((word) => word.startsWith(query));
}

function commandSearchScore(command: AvailableCommand, query: string): number {
  const name = command.name.toLocaleLowerCase();
  const description = command.description?.toLocaleLowerCase() ?? "";
  const nameAcronym = acronym(name);

  if (name === query) return 1000;
  if (name.startsWith(query)) return 900;
  if (hasWordPrefix(query, name)) return 800;
  if (name.includes(query)) return 700;
  if (nameAcronym.startsWith(query)) return 650;
  if (isSubsequence(query, name)) return 500;

  if (description === query) return 300;
  if (description.startsWith(query)) return 250;
  if (hasWordPrefix(query, description)) return 220;
  if (description.includes(query)) return 200;

  return 0;
}

export function sortedServerCommandEntries(
  commands: ReadonlyArray<AvailableCommand>,
): ServerCommandEntry[] {
  const cached = sortedEntriesCache.get(commands);
  if (cached) return cached;

  const entries = commands
    .map((command, index) => ({ command, index }))
    .sort((left, right) => {
      const name = commandNameCollator.compare(left.command.name, right.command.name);
      if (name !== 0) return name;

      const description = commandNameCollator.compare(
        left.command.description ?? "",
        right.command.description ?? "",
      );
      if (description !== 0) return description;

      return left.index - right.index;
    })
    .map(({ command, index }) => ({
      command,
      key: `${command.name}:${command.description ?? ""}:${index}`,
    }));

  sortedEntriesCache.set(commands, entries);
  return entries;
}

export function visibleServerCommandEntries(
  commands: ReadonlyArray<AvailableCommand>,
  search: string | undefined,
): ServerCommandEntry[] {
  const entries = sortedServerCommandEntries(commands);
  const query = search?.trim().toLocaleLowerCase();

  if (!query) return entries;

  return entries
    .map((entry) => ({ entry, score: commandSearchScore(entry.command, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry)
    .slice(0, FILTERED_COMMAND_LIMIT);
}
