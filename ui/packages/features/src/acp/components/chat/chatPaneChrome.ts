import type { AssistantTerminalTab } from "@camber/rpc";
import type {
  AssistantTerminalCommandMode,
  AssistantTerminalPlacement,
} from "../../features/AssistantTerminalRepository.svelte";

// ChatPaneChrome is the contract between AcpChatPane and its host surface: it
// declares which affordances the surface supplies around the pane, so the pane
// only renders controls that actually do something there. Hosts compose the
// pane by describing their chrome instead of toggling individual desktop-shaped
// booleans:
//
// - Desktop main panel: a collapsible conversations sidebar, the pane-owned
//   conversation header, the legacy inline terminal panel, the rounded
//   desktop window frame.
// - Desktop splits: the same sidebar, but the tab bar replaces the pane header
//   ("none"), terminals open as external split tabs, no frame ("plain").
// - IDE editor panels: no chrome at all (omit the prop) — there is no sidebar
//   to expand, so the pane never offers sidebar actions.
// - Mobile: no sidebar or terminal either, and the shell's own top bar is the
//   single header, so the pane renders none ({ header: "none", frame: "plain" }).

/**
 * The host's conversations sidebar, when the surface has one. While collapsed,
 * the pane's conversation header takes over the sidebar's affordances
 * (expand + new conversation). Surfaces without a sidebar omit this entirely.
 */
export interface ChatPaneSidebarChrome {
  collapsed: boolean;
  /** Sidebar width in px; aligns the header's sidebar actions with its edge. */
  width?: number;
  onExpand?: () => void;
}

export type OpenExternalTerminal = (
  worktreePath: string,
  options?: {
    command?: string;
    env?: Record<string, string>;
    commandMode?: AssistantTerminalCommandMode;
    placement?: AssistantTerminalPlacement;
  },
) => Promise<AssistantTerminalTab | undefined>;

/**
 * Where the host wants terminals: the pane-owned legacy side panel, or an
 * external surface the host opens itself (desktop split tabs). Either way the
 * terminal UI only appears on hosts with the terminalPanel capability.
 */
export type ChatPaneTerminalChrome =
  | { surface: "legacy-panel" }
  | { surface: "external"; open: OpenExternalTerminal };

export interface ChatPaneChrome {
  /** Omit on surfaces without a conversations sidebar (mobile, editor panels). */
  sidebar?: ChatPaneSidebarChrome;
  /**
   * "conversation" (default) renders the pane's own "Chatting with …" header;
   * hosts whose chrome already identifies the conversation pass "none".
   */
  header?: "conversation" | "none";
  /** Defaults to the pane-owned legacy terminal panel. */
  terminal?: ChatPaneTerminalChrome;
  /** "desktop-panel" (default) draws the desktop window frame; ignored off desktop. */
  frame?: "desktop-panel" | "plain";
}
