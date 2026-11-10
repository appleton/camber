import type { IconName } from "@camber/components/icon";

export const GOAL_ICON = "target" satisfies IconName;

export function slashCommandIcon(commandName: string): IconName {
  return commandName.toLocaleLowerCase() === "goal" ? GOAL_ICON : "command";
}
