import { describe, expect, it } from "vitest";
import { bareSlashCommand } from "./commands";

describe("bareSlashCommand", () => {
  it("returns the name of a lone slash command", () => {
    expect(bareSlashCommand("/archive")).toBe("archive");
    expect(bareSlashCommand("  /delete-worktree \n")).toBe("delete-worktree");
  });

  it("rejects commands with arguments, mid-sentence commands and plain text", () => {
    expect(bareSlashCommand("/archive the old logs")).toBeNull();
    expect(bareSlashCommand("Look in /archive")).toBeNull();
    expect(bareSlashCommand("archive")).toBeNull();
    expect(bareSlashCommand("/")).toBeNull();
    expect(bareSlashCommand("")).toBeNull();
  });
});
