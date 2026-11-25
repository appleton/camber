// Owns desktop-panel view routing, selected project-settings path, and sidebar collapse state.
export type DesktopView =
  | "chat"
  | "agents"
  | "settings"
  | "shortcuts"
  | "voice"
  | "connectors"
  | "github"
  | "archived"
  | "remote"
  | "project-settings";
export type SettingsView = Exclude<DesktopView, "chat" | "project-settings">;

const SETTINGS_VIEWS: readonly SettingsView[] = [
  "agents",
  "settings",
  "shortcuts",
  "voice",
  "connectors",
  "github",
  "archived",
  "remote",
];

// Validates strings arriving over the host RPC (rpc.openSettings(section)).
export function isSettingsView(value: string): value is SettingsView {
  return (SETTINGS_VIEWS as readonly string[]).includes(value);
}

export class DesktopViewState {
  #view = $state<DesktopView>("chat");
  #projectSettingsPath = $state<string | null>(null);
  #sidebarCollapsed = $state(false);

  get view() {
    return this.#view;
  }
  get projectSettingsPath() {
    return this.#projectSettingsPath;
  }
  get sidebarCollapsed() {
    return this.#sidebarCollapsed;
  }

  setSidebarCollapsed = (collapsed: boolean) => {
    if (collapsed && this.#requiresSidebar()) return;
    this.#sidebarCollapsed = collapsed;
  };
  toggleSidebarCollapsed = () => {
    if (this.#requiresSidebar()) {
      this.#sidebarCollapsed = false;
      return;
    }
    this.#sidebarCollapsed = !this.#sidebarCollapsed;
  };
  showSettings = () => {
    this.#sidebarCollapsed = false;
    this.#view = "settings";
  };
  showShortcuts = () => {
    this.#sidebarCollapsed = false;
    this.#view = "shortcuts";
  };
  showVoice = () => {
    this.#sidebarCollapsed = false;
    this.#view = "voice";
  };
  showConnectors = () => {
    this.#sidebarCollapsed = false;
    this.#view = "connectors";
  };
  showGithub = () => {
    this.#sidebarCollapsed = false;
    this.#view = "github";
  };
  showAgents = () => {
    this.#sidebarCollapsed = false;
    this.#view = "agents";
  };
  showArchived = () => {
    this.#sidebarCollapsed = false;
    this.#view = "archived";
  };
  showRemote = () => {
    this.#sidebarCollapsed = false;
    this.#view = "remote";
  };
  showSettingsSection = (section: SettingsView) => {
    this.#sidebarCollapsed = false;
    this.#view = section;
  };
  showProjectSettings = (path?: string | null) => {
    this.#sidebarCollapsed = false;
    this.#projectSettingsPath = path ?? null;
    this.#view = "project-settings";
  };
  showChat = () => {
    this.#view = "chat";
  };
  restore = (view: DesktopView, projectSettingsPath: string | null) => {
    this.#view = view;
    this.#projectSettingsPath = projectSettingsPath;
    if (this.#requiresSidebar()) {
      this.#sidebarCollapsed = false;
    }
  };
  expandSidebar = () => {
    this.#sidebarCollapsed = false;
  };

  // Views whose navigation lives in the sidebar cannot collapse it. Connectors
  // is deliberately absent: it is a standalone destination (AcpConnectorsView),
  // not a settings section, and collapses like chat.
  #requiresSidebar(): boolean {
    return (
      this.#view === "settings" ||
      this.#view === "shortcuts" ||
      this.#view === "voice" ||
      this.#view === "github" ||
      this.#view === "agents" ||
      this.#view === "archived" ||
      this.#view === "project-settings"
    );
  }
}
