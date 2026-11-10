import type { Tab, TabID } from "@camber/splits";
import { subagentStatusIsRunning } from "../../subagents";
import type { DesktopTabDescriptor } from "./desktopSplitsCache";

export type DesktopSubagentTabStatusKind = "default" | "unread" | "waiting";

export function matchingDesktopSubagentTabId(
  descriptors: Readonly<Record<TabID, DesktopTabDescriptor>>,
  conversationId: string,
  subagentKey: string,
): TabID | undefined {
  return Object.entries(descriptors).find(
    ([, descriptor]) =>
      descriptor.kind === "subagent-chat" &&
      descriptor.conversationId === conversationId &&
      descriptor.subagentKey === subagentKey,
  )?.[0];
}

export function desktopSubagentTabOptions(
  title: string,
): Pick<Tab, "title" | "icon" | "isClosable"> {
  return {
    title: title || "Subagent",
    icon: "agent",
    isClosable: true,
  };
}

export function desktopSubagentTabStatusKind(
  status: string | undefined,
  unread: boolean,
): DesktopSubagentTabStatusKind {
  if (subagentStatusIsRunning(status)) return "waiting";
  if (unread) return "unread";
  return "default";
}
