import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavReportConversationViewState: vi.fn(async () => {}),
}));

import { camberAcpNavReportConversationViewState } from "@camber/helperapi";
import { appState } from "../hostAdapter";
import { reportConversationViewState } from "./conversationViewState";

const reportMock = vi.mocked(camberAcpNavReportConversationViewState);

function setHost(assistantHost: string): void {
  appState.update((state) => ({
    ...state,
    environment: { ...state.environment, assistantHost },
  }));
}

describe("reportConversationViewState", () => {
  beforeEach(() => {
    reportMock.mockClear();
    reportMock.mockImplementation(async () => {});
  });

  it("sends reset on the first report of a webview lifetime only", async () => {
    setHost("desktop");
    reportConversationViewState({ sessionId: "s-1", agentServer: "poolside", active: true });
    reportConversationViewState({ sessionId: "s-1", agentServer: "poolside", active: false });
    await vi.waitFor(() => expect(reportMock).toHaveBeenCalledTimes(2));

    expect(reportMock).toHaveBeenNthCalledWith(1, {
      agentServer: "poolside",
      sessionId: "s-1",
      active: true,
      reset: true,
    });
    expect(reportMock).toHaveBeenNthCalledWith(2, {
      agentServer: "poolside",
      sessionId: "s-1",
      active: false,
    });
  });

  it("reports from the mobile remote", async () => {
    setHost("mobile");
    reportConversationViewState({ sessionId: "s-1", agentServer: "poolside", active: true });
    await vi.waitFor(() => expect(reportMock).toHaveBeenCalledTimes(1));
  });

  it("does not report from split hosts, which report from their extension", async () => {
    setHost("vscode");
    reportConversationViewState({ sessionId: "s-1", agentServer: "poolside", active: true });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("keeps reporting after a failed call", async () => {
    setHost("desktop");
    reportMock.mockRejectedValueOnce(new Error("socket lost"));
    reportConversationViewState({ sessionId: "s-1", agentServer: "poolside", active: true });
    reportConversationViewState({ sessionId: "s-2", agentServer: "poolside", active: true });
    await vi.waitFor(() => expect(reportMock).toHaveBeenCalledTimes(2));
    expect(reportMock.mock.calls[1]?.[0]).toMatchObject({ sessionId: "s-2", active: true });
  });
});
