// The single source of truth for the assistant's keyboard shortcuts.
//
// This file declares *what commands exist*, their human-readable titles, which
// hosts they apply to, and their default chords per host. It does NOT wire
// behavior — components attach handlers by id via the KeybindingService
// (see service.ts). Order matters: `COMMAND_GROUPS` is rendered verbatim by the
// settings UI, so the order here is the order users see. Author the page by
// editing this array.
//
// To add a shortcut:
//   1. Add an entry to the appropriate group below (or add a new group).
//   2. `kb.register("<id>", handler)` wherever the behavior lives.
// The `CommandId` union is derived from this array, so step 2 won't compile
// against a typo, and the dev-time audit (see service.ts) warns about commands
// that are declared but never wired.

import type { KeyChord } from "./chord";

/** Hosts that resolve and dispatch shortcuts differently. */
export type KeybindingHost = "desktop" | "vscode";

export interface CommandDef {
  /**
   * Stable id. For VS Code this is also the command suffix — the contributed
   * command is `camber.<id>` — so ids must match package.json. The union is
   * derived from the registry below (`CommandId`).
   */
  id: CommandId;
  /** Shown as the settings row label and used for hint tooltips. */
  title: string;
  /** Optional longer description for the settings row. */
  description?: string;
  /** Hosts where this command is available. */
  hosts: readonly KeybindingHost[];
  /**
   * Default chord per host. Defaults legitimately differ between hosts: a chord
   * that is free on desktop may already be taken by the editor in VS Code.
   * Omit a host to ship the command with no default binding there.
   */
  defaults: Partial<Record<KeybindingHost, KeyChord>>;
  /**
   * The command is wired by a feature component that owns the relevant state
   * (e.g. the permission prompt, or the chat pane's terminal panel) rather than
   * by the desktop runtime's initialize(), and it is not a VS Code contribution.
   * Such commands still appear in the registry (listed + configurable), but the
   * desktop "unwired" audit and the VS Code drift test skip them — the runtime
   * doesn't register them at init and there is no package.json keybinding.
   */
  external?: boolean;
}

export interface CommandGroup {
  /** Section heading in the settings UI. */
  category: string;
  commands: readonly CommandDef[];
}

// Authored literal. `as const` preserves the string-literal ids so `CommandId`
// can be derived below; the public `COMMAND_GROUPS` is the widened view callers
// iterate (where `description` is optional and `hosts` is `KeybindingHost[]`).
const GROUPS = [
  {
    category: "Conversation",
    commands: [
      {
        id: "newConversation",
        title: "New Conversation",
        hosts: ["desktop", "vscode"],
        defaults: { desktop: "mod+n" },
      },
      {
        id: "searchConversations",
        title: "Search Conversations",
        hosts: ["desktop"],
        defaults: { desktop: "mod+k" },
      },
      {
        id: "nextUnreadConversation",
        title: "Next Unread Conversation",
        description: "Jump to a conversation that needs your attention.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+shift+u" },
      },
      {
        id: "showSidebar",
        title: "Show Sidebar",
        hosts: ["vscode"],
        defaults: { vscode: "mod+escape" },
      },
    ],
  },
  {
    category: "Project",
    commands: [
      {
        id: "newProject",
        title: "New Project",
        description: "Add a project folder.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+shift+o" },
      },
      {
        id: "newWorktree",
        title: "New Worktree",
        description: "Create a worktree for the current project.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+shift+w" },
      },
      {
        id: "openInIde",
        title: "Open in IDE",
        description: "Open the current workspace in your editor.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+shift+i" },
      },
    ],
  },
  {
    category: "Prompt",
    commands: [
      {
        id: "focusInput",
        title: "Focus Prompt Input",
        description: "Move keyboard focus to the chat prompt.",
        hosts: ["desktop", "vscode"],
        // Free on desktop; intentionally unbound in VS Code where mod+i is the
        // editor inline-chat trigger. The command + toolbar button still exist there.
        defaults: { desktop: "mod+i" },
      },
      {
        id: "interrupt",
        title: "Stop Agent",
        description: "Stop the active agent turn.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+." },
        external: true,
      },
      {
        id: "togglePlanMode",
        title: "Toggle Plan Mode",
        hosts: ["desktop", "vscode"],
        defaults: { desktop: "mod+shift+p", vscode: "shift+tab" },
      },
      {
        id: "toggleDictation",
        title: "Toggle Dictation",
        description: "Start or stop dictating into the prompt with the local voice model.",
        hosts: ["desktop"],
        // Cmd+Shift+D belongs to the native Split Down menu command.
        defaults: { desktop: "mod+shift+space" },
        external: true,
      },
    ],
  },
  {
    category: "Approvals",
    commands: [
      {
        id: "approve",
        title: "Approve",
        description: "Approve the pending tool request.",
        hosts: ["desktop", "vscode"],
        defaults: { desktop: "alt+a", vscode: "alt+a" },
        external: true,
      },
      {
        id: "reject",
        title: "Reject",
        description: "Reject the pending tool request.",
        hosts: ["desktop", "vscode"],
        defaults: { desktop: "escape", vscode: "escape" },
        external: true,
      },
    ],
  },
  {
    category: "Panels",
    commands: [
      {
        id: "toggleLeftPanel",
        title: "Toggle Sidebar",
        description: "Collapse or show the conversation sidebar.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+b" },
      },
      {
        id: "toggleRightPanel",
        title: "Toggle Secondary Sidebar",
        description: "Show or hide the secondary sidebar.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+alt+b" },
      },
      {
        id: "toggleBottomPanel",
        title: "Toggle Panel",
        description: "Show or hide the bottom panel.",
        hosts: ["desktop"],
        defaults: { desktop: "mod+j" },
      },
    ],
  },
  {
    category: "Application",
    commands: [
      {
        id: "openSettings",
        title: "Settings",
        hosts: ["vscode"],
        defaults: {},
      },
    ],
  },
] as const;

export type CommandId = (typeof GROUPS)[number]["commands"][number]["id"];

export const COMMAND_GROUPS: readonly CommandGroup[] = GROUPS;

export const ALL_COMMANDS: readonly CommandDef[] = COMMAND_GROUPS.flatMap(
  (group) => group.commands,
);

export const COMMAND_BY_ID: ReadonlyMap<CommandId, CommandDef> = new Map(
  ALL_COMMANDS.map((command) => [command.id, command]),
);

/** The contributed VS Code command name for a registry id. */
export function vscodeCommandId(id: CommandId): string {
  return `camber.${id}`;
}

/** Resolve the default chord for a command on a host, or null when unbound. */
export function defaultChord(id: CommandId, host: KeybindingHost): KeyChord | null {
  return COMMAND_BY_ID.get(id)?.defaults[host] ?? null;
}
