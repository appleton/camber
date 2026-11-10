import { createVSCodeMock } from "jest-mock-vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { System } from "../system";
import { getWebviewHtml } from "./getWebviewHtml";
const mock = vi.hoisted(() => ({ readFile: vi.fn(), state: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: mock.readFile,
  default: { readFile: mock.readFile },
}));
vi.mock("vscode", () => {
  const api = createVSCodeMock(vi);
  return { ...api, env: { ...api.env, asExternalUri: vi.fn() } };
});
vi.mock("../system", () => ({}));
vi.mock("../api/configuration", () => ({
  getCamberConfigurationSection: () => ({ get: () => 0 }),
}));
vi.mock("../state", () => ({ getInitialAppStateAsJSON: mock.state }));
const manifest = {
  "src/webview/assistant.main.ts": {
    file: "webview/assistant.js",
    css: ["webview/entry.css"],
    imports: ["shared"],
  },
  "src/webview/acp-chat.main.ts": { file: "webview/chat.js", imports: ["shared"] },
  shared: { file: "webview/shared.js", css: ["webview/shared.css"] },
};
function setup(mode = vscode.ExtensionMode.Production) {
  const system = {
    context: {
      extensionMode: mode,
      extensionPath: "/extension",
      extensionUri: vscode.Uri.file("/extension"),
    },
  } as System;
  const webview = { asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;
  return { system, webview };
}
beforeEach(() => {
  vi.useFakeTimers();
  mock.readFile.mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(manifest)), 20)),
  );
  mock.state.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(JSON.stringify({ draft: "日本語 🧵 </script>\u2028" })), 20),
      ),
  );
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => 0 } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("reads the manifest and initial state concurrently", async () => {
  const { system, webview } = setup();
  let html: string | undefined;
  const pending = getWebviewHtml(system, webview, "assistant").then((value) => (html = value));
  await vi.advanceTimersByTimeAsync(20);
  expect(html).toContain('src="webview/assistant.js"');
  await pending;
});
it("shares a release manifest between views while preserving fresh initial state and exact UTF-8", async () => {
  const { system, webview } = setup();
  const pending = Promise.all([
    getWebviewHtml(system, webview, "assistant"),
    getWebviewHtml(system, webview, "acp-chat"),
  ]);
  await vi.runAllTimersAsync();
  const [assistant, chat] = await pending;
  expect(mock.readFile).toHaveBeenCalledTimes(1);
  expect(mock.state).toHaveBeenCalledTimes(2);
  for (const html of [assistant, chat]) {
    expect(html).toContain('rel="modulepreload" href="webview/shared.js"');
    const encoded = html.match(/CAMBER_INITIAL_STATE = decode\("([^"]+)"\)/)![1];
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      draft: "日本語 🧵 </script>\u2028",
    });
    expect(html).not.toContain("日本語");
  }
});
it("retries a failed manifest read and keeps different installations independent", async () => {
  const { system, webview } = setup();
  mock.readFile.mockRejectedValueOnce(new Error("missing manifest"));
  const failed = expect(getWebviewHtml(system, webview, "assistant")).rejects.toThrow(
    "missing manifest",
  );
  await vi.runAllTimersAsync();
  await failed;
  const pending = getWebviewHtml(system, webview, "assistant");
  await vi.runAllTimersAsync();
  expect(await pending).toContain("webview/assistant.js");
  const other = getWebviewHtml(setup().system, webview, "assistant");
  await vi.runAllTimersAsync();
  await other;
  expect(mock.readFile).toHaveBeenCalledTimes(3);
});
it("uses fresh development port forwarding and never reads a release manifest", async () => {
  const { system, webview } = setup(vscode.ExtensionMode.Development);
  vi.mocked(vscode.env.asExternalUri)
    .mockResolvedValueOnce(vscode.Uri.parse("https://first.example/"))
    .mockResolvedValueOnce(vscode.Uri.parse("https://second.example/"));
  const one = getWebviewHtml(system, webview, "assistant");
  await vi.runAllTimersAsync();
  expect(await one).toContain('href="https://first.example/"');
  const two = getWebviewHtml(system, webview, "acp-chat");
  await vi.runAllTimersAsync();
  expect(await two).toContain('href="https://second.example/"');
  expect(mock.readFile).not.toHaveBeenCalled();
  expect(vscode.env.asExternalUri).toHaveBeenCalledTimes(2);
});
it("refreshes mutable state while reusing the immutable release manifest", async () => {
  const { system, webview } = setup();
  const one = getWebviewHtml(system, webview, "assistant");
  await vi.runAllTimersAsync();
  await one;
  mock.state.mockResolvedValueOnce('{"theme":"changed"}');
  const two = await getWebviewHtml(system, webview, "assistant");
  const encoded = two.match(/CAMBER_INITIAL_STATE = decode\("([^"]+)"\)/)![1];
  expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({ theme: "changed" });
  expect(mock.readFile).toHaveBeenCalledTimes(1);
});
