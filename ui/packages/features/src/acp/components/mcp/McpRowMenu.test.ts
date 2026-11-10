import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../hostAdapter";
import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";
import McpRowMenu from "./McpRowMenu.svelte";

vi.mock("../ui/menuSpec", () => ({ presentNativeMenu: vi.fn() }));

const mockPresentNativeMenu = vi.mocked(presentNativeMenu);

function setEnvironment(assistantHost: string, operatingSystem?: string): void {
  appState.update((state) => ({
    ...state,
    environment: { ...state.environment, assistantHost, operatingSystem },
  }));
}

const items: MenuSpecItem[] = [
  { kind: "action", id: "test-connection", label: "Test connection", icon: "run" },
  { kind: "separator" },
  { kind: "action", id: "delete", label: "Delete", icon: "trash", destructive: true },
  { kind: "action", id: "managed", label: "Managed by Camber", icon: "info", enabled: false },
];

describe("McpRowMenu", () => {
  afterEach(() => {
    setEnvironment("", undefined);
    vi.clearAllMocks();
  });

  describe("DOM popover", () => {
    it("renders actions as buttons and disabled actions as inert rows", async () => {
      render(McpRowMenu, { props: { items, onSelect: vi.fn() } });

      await fireEvent.click(screen.getByRole("button", { name: "Connector actions" }));

      expect(screen.getByRole("button", { name: /Test connection/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
      expect(screen.getByText("Managed by Camber")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Managed by Camber/ })).toBeNull();
    });

    it("reports the selected item id and closes the menu", async () => {
      const onSelect = vi.fn();
      render(McpRowMenu, { props: { items, onSelect } });

      await fireEvent.click(screen.getByRole("button", { name: "Connector actions" }));
      await fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

      expect(onSelect).toHaveBeenCalledExactlyOnceWith("delete");
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument(),
      );
    });
  });

  describe("native menu host", () => {
    it("presents the native menu from the trigger, anchored bottom-end, and reports the selection", async () => {
      setEnvironment("desktop", "darwin");
      mockPresentNativeMenu.mockResolvedValue("delete");
      const onSelect = vi.fn();

      render(McpRowMenu, { props: { items, onSelect } });

      await fireEvent.click(screen.getByRole("button", { name: "Connector actions" }));
      await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("delete"));

      // No DOM menu renders; the OS owns the surface.
      expect(screen.queryByRole("button", { name: /Test connection/ })).toBeNull();

      expect(mockPresentNativeMenu).toHaveBeenCalledExactlyOnceWith(
        items,
        expect.objectContaining({ align: "end" }),
      );
    });

    it("does not report a selection when the native menu is dismissed", async () => {
      setEnvironment("desktop", "darwin");
      mockPresentNativeMenu.mockResolvedValue(undefined);
      const onSelect = vi.fn();

      render(McpRowMenu, { props: { items, onSelect } });

      await fireEvent.click(screen.getByRole("button", { name: "Connector actions" }));
      await waitFor(() => expect(mockPresentNativeMenu).toHaveBeenCalledOnce());

      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
