import type { IconName } from "@camber/components/icon";

export type DesktopSettingsSection =
  | "preferences"
  | "shortcuts"
  | "models"
  | "voice"
  | "connectors"
  | "github"
  | "agents"
  | "archived"
  | "remote";
export type DesktopSettingsNavSection = DesktopSettingsSection | "project-settings";
export type SettingsSection = "all" | DesktopSettingsSection;

// "connectors" is deliberately omitted from the settings sections: connectors is
// its own top-level destination (opened from the sidebar), not a settings tab.
export const DESKTOP_SETTINGS_SECTIONS = [
  "preferences",
  "agents",
  "models",
  "voice",
  "shortcuts",
  "github",
  "archived",
  "remote",
] as const satisfies readonly DesktopSettingsSection[];

export const DESKTOP_SETTINGS_NAV_SECTIONS = [
  "preferences",
  "project-settings",
  "agents",
  "models",
  "voice",
  "shortcuts",
  "github",
  "archived",
  "remote",
] as const satisfies readonly DesktopSettingsNavSection[];

export const IDE_SETTINGS_SECTIONS = [
  "connectors",
  "agents",
] as const satisfies readonly DesktopSettingsSection[];

export const SETTINGS_HEADINGS: Record<SettingsSection, { title: string; subtitle: string }> = {
  all: {
    title: "Settings",
    subtitle:
      "Configure preferences, local models, voice recognition, MCP connections, and ACP agents.",
  },
  preferences: { title: "General", subtitle: "Appearance and API settings." },
  shortcuts: { title: "Keyboard Shortcuts", subtitle: "Keyboard shortcuts for the app." },
  models: {
    title: "On-Device Models",
    subtitle: "Install and choose local MLX models.",
  },
  voice: {
    title: "Voice Recognition",
    subtitle: "Install and choose local Whisper models for dictation.",
  },
  connectors: { title: "Connectors", subtitle: "MCP servers available to your agents." },
  github: { title: "GitHub", subtitle: "Pull-request awareness, status colors, and access." },
  agents: { title: "Agents", subtitle: "Choose and configure ACP agents and harnesses." },
  archived: {
    title: "Archived Chats",
    subtitle: "View, restore, or delete archived conversations.",
  },
  remote: {
    title: "Remote Access",
    subtitle: "Control this desktop from your phone over Tailscale.",
  },
};

export const SETTINGS_NAV_ITEMS: Record<
  DesktopSettingsNavSection,
  { label: string; icon: IconName; badge?: IconName; pill?: string }
> = {
  preferences: { label: "General", icon: "gear" },
  "project-settings": { label: "Projects", icon: "folder" },
  shortcuts: { label: "Keyboard Shortcuts", icon: "keyboard" },
  models: { label: "On-Device Models", icon: "on-device" },
  voice: { label: "Voice Recognition", icon: "microphone" },
  connectors: { label: "Connectors", icon: "mcp" },
  github: { label: "GitHub", icon: "github" },
  agents: { label: "Agents", icon: "sparkles" },
  archived: { label: "Archived Chats", icon: "archive" },
  remote: { label: "Remote Access", icon: "remote-access", pill: "Experimental" },
};
