import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { camberListSkills } from "@camber/helperapi";
import { installedSkillsAsCommands } from "./serverCommands";

type ListSkills = typeof camberListSkills;

export class InstalledSkillsRepository {
  commands = $state<AvailableCommand[]>([]);

  private refreshPromise: Promise<void> | undefined;

  constructor(private readonly listSkills: ListSkills = (input) => camberListSkills(input)) {}

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    const request = Promise.resolve()
      .then(() => this.listSkills({}))
      .then(({ skills }) => {
        this.commands = installedSkillsAsCommands(skills);
      })
      .catch(() => {
        // Some remote hosts do not expose helper-local filesystem methods.
      })
      .finally(() => {
        if (this.refreshPromise === request) this.refreshPromise = undefined;
      });
    this.refreshPromise = request;
    return request;
  }
}

export const installedSkills = new InstalledSkillsRepository();
