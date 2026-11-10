import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readStoredApplyDefaultDesktopLayoutToChats,
  type PersistedDesktopLayout,
} from "./chat/desktopLayoutPersistence";
import DesktopDefaultLayoutSection from "./DesktopDefaultLayoutSection.svelte";

const DESKTOP_LAYOUT_STORAGE_KEY = "camber.desktop.layouts.v1";

function savedDefaultLayout(): PersistedDesktopLayout {
  return {
    version: 1,
    surfaces: {
      main: {
        version: 1,
        rootNode: {
          type: "pane",
          pane: {
            id: "pane-main",
            tabs: [
              { id: "tab-chat", title: "Chat", icon: "agent", isDirty: false },
              { id: "tab-terminal", title: "Terminal", icon: null, isDirty: false },
            ],
            selectedTabId: "tab-chat",
          },
        },
      },
      rightSidebar: {
        version: 1,
        rootNode: { type: "pane", pane: { id: "pane-right", tabs: [] } },
      },
      bottomPanel: {
        version: 1,
        rootNode: { type: "pane", pane: { id: "pane-bottom", tabs: [] } },
      },
    },
    descriptors: {
      "tab-chat": { kind: "chat" },
      "tab-terminal": { kind: "terminal", worktreePath: "" },
    },
    rightSidebarVisible: false,
    bottomPanelVisible: false,
    activeSurface: "main",
  };
}

describe("DesktopDefaultLayoutSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the standard single-chat-panel preview when no default is set", async () => {
    render(DesktopDefaultLayoutSection);

    expect(await screen.findByLabelText("Standard layout preview")).toBeInTheDocument();
    expect(
      screen.getByText("No default set — new conversations open a single chat panel."),
    ).toBeInTheDocument();
    // The standard preview renders exactly one chat tab and no clear button.
    expect(screen.getByRole("button", { name: "Show Chat preview" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Also apply to new chats" })).not.toBeChecked();
    expect(
      screen.getByText(
        "By default, chats always get a single tab layout. Project sessions always use the saved default layout.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear default layout" })).not.toBeInTheDocument();
  });

  it("shows the saved default layout preview and the clear button when a default is set", async () => {
    window.localStorage.setItem(
      DESKTOP_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        conversations: {},
        defaultLayout: savedDefaultLayout(),
      }),
    );

    render(DesktopDefaultLayoutSection);

    expect(await screen.findByLabelText("Current default layout preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Terminal preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear default layout" })).toBeInTheDocument();
    expect(
      screen.queryByText("No default set — new conversations open a single chat panel."),
    ).not.toBeInTheDocument();
  });

  it("persists the opt-in to apply default layouts to new chats", async () => {
    render(DesktopDefaultLayoutSection);
    const applyToChats = screen.getByRole("switch", { name: "Also apply to new chats" });

    expect(applyToChats).not.toBeChecked();
    await fireEvent.click(applyToChats);

    expect(applyToChats).toBeChecked();
    expect(readStoredApplyDefaultDesktopLayoutToChats()).toBe(true);
  });
});
