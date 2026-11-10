import { describe, expect, it, vi } from "vitest";
import { installedSkills } from "./InstalledSkillsRepository.svelte";

vi.mock("@camber/helperapi", () => ({}));

describe("InstalledSkillsRepository", () => {
  it("treats a missing helper method as unavailable", async () => {
    await expect(installedSkills.refresh()).resolves.toBeUndefined();
    expect(installedSkills.commands).toEqual([]);
  });
});
