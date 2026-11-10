import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getInitialAppState, getInitialKeybindings } from "./state";
import type { System } from "./system";

const mock = vi.hoisted(() => ({
  keybindings: vi.fn(),
  colorTheme: vi.fn(),
  iconTheme: vi.fn(),
}));
vi.mock("vscode", () => createVSCodeMock(vi));
vi.mock("./system", () => ({}));
vi.mock("./configuration", () => ({ getCamberConfig: () => ({ test: true }) }));
vi.mock("./context", () => ({ getWorkspaces: () => [], getDefaultCwd: () => "/repo" }));
vi.mock("./languages", () => ({ getLanguages: () => [], serializeLanguages: () => [] }));
vi.mock("./env", () => ({ mapContextToExtensionMode: () => "production" }));
vi.mock("./rpc/handlers/getKeybindings", () => ({ getKeybindings: mock.keybindings }));
vi.mock("./theme", () => ({
  getActiveTheme: mock.colorTheme,
  getParsedFileIconTheme: mock.iconTheme,
}));
const system = { context: { extensionMode: 1 } } as System;
beforeEach(() => {
  vi.useFakeTimers();
  mock.keybindings.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve({ binding: "cmd+l" }), 20)),
  );
  mock.colorTheme.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve({ name: "theme" }), 20)),
  );
  mock.iconTheme.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve({ name: "icons" }), 20)),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("prepares independent initial-state resources in one I/O interval", async () => {
  let state: Awaited<ReturnType<typeof getInitialAppState>> | undefined;
  const pending = getInitialAppState(system).then((value) => (state = value));
  await vi.advanceTimersByTimeAsync(20);
  expect(state).toMatchObject({
    keybindings: { binding: "cmd+l" },
    colorTheme: { name: "theme" },
    fileIconTheme: { name: "icons" },
    defaultCwd: "/repo",
  });
  await pending;
});
it("propagates resource errors without leaving another request unhandled", async () => {
  mock.colorTheme.mockRejectedValueOnce(new Error("theme unavailable"));
  mock.iconTheme.mockRejectedValueOnce(new Error("icons unavailable"));
  const pending = getInitialAppState(system);
  const check = expect(pending).rejects.toThrow("theme unavailable");
  await vi.runAllTimersAsync();
  await check;
});

it("refreshes keybindings without re-reading theme and icon files", async () => {
  const pending = getInitialKeybindings();
  await vi.runAllTimersAsync();
  expect(await pending).toEqual({ binding: "cmd+l" });
  expect(mock.colorTheme).not.toHaveBeenCalled();
  expect(mock.iconTheme).not.toHaveBeenCalled();
});
