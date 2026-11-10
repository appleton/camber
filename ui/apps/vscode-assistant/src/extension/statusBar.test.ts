import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { CAMBER_EXTENSION_ID, configureExtensionIdentity } from "./extensionIdentity";
import { createStatusBarItem } from "./statusBar";

vi.mock("vscode", () => createVSCodeMock(vi));

describe("createStatusBarItem", () => {
  afterEach(() => {
    configureExtensionIdentity(CAMBER_EXTENSION_ID);
  });

  it("shows a right-aligned launch button wired to focusInput", () => {
    const statusBarItem = createStatusBarItem();

    expect(statusBarItem.text).toBe("$(camber-roundel)");
    expect(statusBarItem.tooltip).toBe("Open Camber Assistant");
    expect(statusBarItem.command).toBe("camber.focusInput");
    expect(statusBarItem.alignment).toBe(vscode.StatusBarAlignment.Right);
    expect(statusBarItem.show).toHaveBeenCalled();
  });

  it("namespaces the icon and command for the dev variant", () => {
    configureExtensionIdentity("appleton.camber-assistant-dev");

    const statusBarItem = createStatusBarItem();

    expect(statusBarItem.text).toBe("$(camber-dev-roundel)");
    expect(statusBarItem.command).toBe("camber-dev.focusInput");
  });
});
