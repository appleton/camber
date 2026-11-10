import { createVSCodeMock } from "jest-mock-vscode";

vi.mock("vscode", () => createVSCodeMock(vi));
vi.mock("../../api/configuration", () => ({ getConfiguration: vi.fn() }));

import { findKeybinding, type Keybinding } from "./getKeybindings";

const extensionBindings: Keybinding[] = [
  { command: "camber.focusInput", key: "ctrl+l", mac: "cmd+l" },
  { command: "camber.focusInput", key: "ctrl+escape", mac: "cmd+escape" }, // override previous binding
  { command: "camber.togglePlanMode", key: "shift+tab" },
];

describe("findKeybinding", () => {
  it("returns the last matching binding from extension defaults", () => {
    expect(findKeybinding(extensionBindings, [], "camber.focusInput", "mac")).toBe("cmd+escape");
  });

  it("returns platform-specific key when available", () => {
    expect(findKeybinding(extensionBindings, [], "camber.togglePlanMode", "mac")).toBe("shift+tab");
    expect(findKeybinding(extensionBindings, [], "camber.togglePlanMode", "linux")).toBe(
      "shift+tab",
    );
  });

  it("falls back to key when platform-specific key is missing", () => {
    const ext: Keybinding[] = [{ command: "test.cmd", key: "ctrl+a" }];
    expect(findKeybinding(ext, [], "test.cmd", "mac")).toBe("ctrl+a");
  });

  it("returns undefined for unknown commands", () => {
    expect(findKeybinding(extensionBindings, [], "unknown.command", "mac")).toBeUndefined();
  });

  describe("user overrides", () => {
    it("user binding overrides extension default", () => {
      const user: Keybinding[] = [
        { command: "camber.togglePlanMode", key: "ctrl+alt+9" },
        { command: "-camber.togglePlanMode", key: "shift+tab" },
      ];
      expect(findKeybinding(extensionBindings, user, "camber.togglePlanMode", "mac")).toBe(
        "ctrl+alt+9",
      );
    });

    it("user add+remove for same key: user add survives, removal only targets extension default", () => {
      const user: Keybinding[] = [
        { command: "camber.togglePlanMode", key: "shift+tab" },
        { command: "-camber.togglePlanMode", key: "shift+tab" },
      ];
      expect(findKeybinding(extensionBindings, user, "camber.togglePlanMode", "mac")).toBe(
        "shift+tab",
      );
    });

    it("handles modifier order differences (tab+shift vs shift+tab)", () => {
      const user: Keybinding[] = [
        { command: "camber.togglePlanMode", key: "tab+shift" },
        { command: "-camber.togglePlanMode", key: "shift+tab" },
      ];
      expect(findKeybinding(extensionBindings, user, "camber.togglePlanMode", "mac")).toBe(
        "tab+shift",
      );
    });

    it("removal only affects the specific key, not other bindings for the same command", () => {
      const user: Keybinding[] = [{ command: "-camber.focusInput", key: "ctrl+l", mac: "cmd+l" }];
      expect(findKeybinding(extensionBindings, user, "camber.focusInput", "mac")).toBe(
        "cmd+escape",
      );
    });

    it("unbind-only entry disables the extension default", () => {
      const user: Keybinding[] = [{ command: "-camber.togglePlanMode", key: "shift+tab" }];
      expect(
        findKeybinding(extensionBindings, user, "camber.togglePlanMode", "mac"),
      ).toBeUndefined();
    });

    it("handles profile keybindings overriding extension defaults", () => {
      const user: Keybinding[] = [
        { command: "camber.togglePlanMode", key: "ctrl+alt+9" },
        { command: "-camber.togglePlanMode", key: "shift+tab" },
      ];
      expect(findKeybinding(extensionBindings, user, "camber.togglePlanMode", "mac")).toBe(
        "ctrl+alt+9",
      );
    });
  });
});
