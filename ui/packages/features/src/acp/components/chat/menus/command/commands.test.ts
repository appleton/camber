import { describe, expect, it } from "vitest";
import { bareSlashCommand, isSlashCommandOnlyPrompt } from "./commands";

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

describe("isSlashCommandOnlyPrompt", () => {
  it("accepts an empty prompt, a lone slash and a partly typed command", () => {
    expect(isSlashCommandOnlyPrompt("")).toBe(true);
    expect(isSlashCommandOnlyPrompt("/")).toBe(true);
    expect(isSlashCommandOnlyPrompt("/arc")).toBe(true);
    expect(isSlashCommandOnlyPrompt(" /delete-worktree ")).toBe(true);
  });

  it("rejects commands after other text or with arguments", () => {
    expect(isSlashCommandOnlyPrompt("Look in /arc")).toBe(false);
    expect(isSlashCommandOnlyPrompt("/archive the old logs")).toBe(false);
    expect(isSlashCommandOnlyPrompt("archive")).toBe(false);
  });
});
