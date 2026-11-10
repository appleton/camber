import { describe, expect, it } from "vitest";
import {
  installedSkillsAsCommands,
  isSkillCommand,
  resolvedSkillCommands,
  resolvedSlashCommandNames,
  skillInvocation,
  sortedServerCommandEntries,
  visibleServerCommandEntries,
} from "./serverCommands";

describe("skill commands", () => {
  it("recognizes published skills by prefix or ACP metadata", () => {
    expect(isSkillCommand({ name: "$uv", description: "Use uv" })).toBe(true);
    expect(
      isSkillCommand({
        name: "piano",
        description: "Compose music",
        _meta: { "camber/slash_command_category": "skill" },
      }),
    ).toBe(true);
    expect(isSkillCommand({ name: "help", description: "Show help" })).toBe(false);
  });

  it("merges published skills with helper-discovered skills", () => {
    const installed = installedSkillsAsCommands([
      { name: "uv", description: "Use uv" },
      { name: "$slides", description: "Create slides" },
    ]);

    expect(installed.map(({ name }) => name)).toEqual(["$uv", "$slides"]);
    expect(resolvedSkillCommands([{ name: "help", description: "Show help" }], installed)).toEqual(
      installed,
    );
    expect(
      resolvedSkillCommands([{ name: "$agent-skill", description: "Agent skill" }], installed).map(
        ({ name }) => name,
      ),
    ).toEqual(["$agent-skill", "$uv", "$slides"]);
  });

  it("prefers the published entry when a skill appears in both sources", () => {
    const installed = installedSkillsAsCommands([
      { name: "uv", description: "Helper description" },
      { name: "slides", description: "Create slides" },
    ]);

    const resolved = resolvedSkillCommands(
      [{ name: "$UV", description: "Published description" }],
      installed,
    );

    expect(resolved.map(({ name }) => name)).toEqual(["$UV", "$slides"]);
    expect(resolved[0]?.description).toBe("Published description");
  });

  it("normalizes skill invocations to the $ convention", () => {
    expect(skillInvocation("$uv")).toBe("$uv");
    expect(skillInvocation("piano")).toBe("$piano");
  });

  it("includes helper-discovered skills in the names used by transcript markdown", () => {
    const installed = installedSkillsAsCommands([
      { name: "helper-only", description: "Only discovered by the helper" },
    ]);

    expect(
      resolvedSlashCommandNames([{ name: "plan", description: "Plan work" }], installed),
    ).toEqual({
      skills: ["$helper-only"],
      commands: ["plan"],
    });
  });
});

describe("sortedServerCommandEntries", () => {
  it("sorts commands alphabetically and keeps duplicate names addressable", () => {
    const entries = sortedServerCommandEntries([
      { name: "usage", description: "Usage" },
      { name: "debug", description: "Debug logging" },
      { name: "Debug", description: "Alternate debug command" },
      { name: "batch", description: "Batch work" },
    ]);

    expect(entries.map(({ command }) => command.name)).toEqual([
      "batch",
      "Debug",
      "debug",
      "usage",
    ]);
    expect(new Set(entries.map(({ key }) => key)).size).toBe(entries.length);
  });

  it("renders every command before search so the menu is discoverable", () => {
    const entries = visibleServerCommandEntries(
      Array.from({ length: 20 }, (_, index) => ({
        name: `command-${String(index).padStart(2, "0")}`,
        description: `Description ${index}`,
      })),
      undefined,
    );

    expect(entries).toHaveLength(20);
    expect(entries.map(({ command }) => command.name).slice(0, 4)).toEqual([
      "command-00",
      "command-01",
      "command-02",
      "command-03",
    ]);
  });

  it("ranks exact command name matches above weaker alphabetical matches", () => {
    const entries = visibleServerCommandEntries(
      [
        { name: "alpha", description: "Configure alpha settings" },
        { name: "configure", description: "Configure the assistant" },
        { name: "beta", description: "Configure beta settings" },
        { name: "code-review", description: "Review the current diff for correctness bugs" },
        {
          name: "weak-description",
          description: "Contains c o n f i g u r e only as scattered letters",
        },
        { name: "qa", description: "Systematically QA a web application" },
      ],
      "configure",
    );

    expect(entries.map(({ command }) => command.name)).toEqual(["configure", "alpha", "beta"]);
  });

  it("ranks direct name matches ahead of description matches", () => {
    const entries = visibleServerCommandEntries(
      [
        { name: "batch", description: "Run parallel work" },
        { name: "usage", description: "Contains batch only in the description" },
        { name: "batch-runner", description: "Run batches" },
        { name: "debug", description: "Enable debug logging" },
      ],
      "bat",
    );

    expect(entries.map(({ command }) => command.name)).toEqual(["batch", "batch-runner", "usage"]);
  });

  it("keeps prefix and word-boundary name matches ahead of fuzzy name matches", () => {
    const entries = visibleServerCommandEntries(
      [
        { name: "repository-update-notifier", description: "Notify about repository updates" },
        { name: "test-runner", description: "Run tests" },
        { name: "run", description: "Run a command" },
      ],
      "run",
    );

    expect(entries.map(({ command }) => command.name)).toEqual([
      "run",
      "test-runner",
      "repository-update-notifier",
    ]);
  });

  it("uses alphabetic order only as a final tie-breaker within the same match tier", () => {
    const entries = visibleServerCommandEntries(
      [
        { name: "zebra-config", description: "Configure zebra" },
        { name: "alpha-config", description: "Configure alpha" },
        { name: "beta-config", description: "Configure beta" },
      ],
      "config",
    );

    expect(entries.map(({ command }) => command.name)).toEqual([
      "alpha-config",
      "beta-config",
      "zebra-config",
    ]);
  });

  it("limits filtered command results after relevance sorting", () => {
    const commands = [
      { name: "configure", description: "Configure the assistant" },
      ...Array.from({ length: 40 }, (_, index) => ({
        name: `command-${String(index).padStart(2, "0")}`,
        description: "Configure something else",
      })),
    ];

    const entries = visibleServerCommandEntries(commands, "configure");

    expect(entries).toHaveLength(30);
    expect(entries[0].command.name).toBe("configure");
  });
});
