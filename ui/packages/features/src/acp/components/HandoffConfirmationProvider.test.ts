import { InfoMessageType } from "@camber/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ACPHandoffConfirmationController } from "../features/HandoffConfirmationContext";
import { rpc } from "../hostRpc";
import Harness from "./HandoffConfirmationProvider.test.svelte";

vi.mock("../hostRpc", () => ({
  rpc: {
    showInfoMessage: vi.fn(async () => undefined),
  },
}));

function makeRepo(defaultAgentServer = "poolside", defaultAgentServerPinned = false) {
  return {
    handoffSession: vi.fn().mockResolvedValue(undefined),
    agents: { defaultAgentServer, defaultAgentServerPinned },
  };
}

function renderProvider(repo: ReturnType<typeof makeRepo>) {
  const agentServers = { setDefaultAgentServer: vi.fn().mockResolvedValue(undefined) };
  let controller: ACPHandoffConfirmationController | undefined;
  render(Harness, {
    props: {
      repo,
      agentServers,
      onController: (value: ACPHandoffConfirmationController) => (controller = value),
    },
  });
  if (!controller) throw new Error("provider did not expose a confirmation controller");
  return { agentServers, controller };
}

describe("HandoffConfirmationProvider", () => {
  it("remembers the target agent as last-used when the handoff is accepted", async () => {
    const repo = makeRepo();
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Hand Off" }));

    await waitFor(() =>
      expect(agentServers.setDefaultAgentServer).toHaveBeenCalledExactlyOnceWith("claude-acp"),
    );
    expect(repo.handoffSession).toHaveBeenCalledExactlyOnceWith("conversation:1", "claude-acp");
  });

  it("skips the last-used write when the target is already the remembered agent", async () => {
    const repo = makeRepo("claude-acp");
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Hand Off" }));

    await waitFor(() =>
      expect(repo.handoffSession).toHaveBeenCalledExactlyOnceWith("conversation:1", "claude-acp"),
    );
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("skips the last-used write entirely while the default agent is pinned", async () => {
    // A pinned default agent is a deliberate choice: even a completed handoff
    // to another agent must not overwrite it.
    const repo = makeRepo("poolside", true);
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Hand Off" }));

    await waitFor(() =>
      expect(repo.handoffSession).toHaveBeenCalledExactlyOnceWith("conversation:1", "claude-acp"),
    );
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("records the agent only after the handoff succeeds", async () => {
    const repo = makeRepo();
    let releaseHandoff: () => void = () => {};
    repo.handoffSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseHandoff = resolve;
        }),
    );
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Hand Off" }));

    // The handoff is still in flight: nothing is remembered yet.
    expect(repo.handoffSession).toHaveBeenCalledExactlyOnceWith("conversation:1", "claude-acp");
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();

    releaseHandoff();
    await waitFor(() =>
      expect(agentServers.setDefaultAgentServer).toHaveBeenCalledExactlyOnceWith("claude-acp"),
    );
  });

  it("does not switch the remembered agent when the handoff fails", async () => {
    const repo = makeRepo();
    repo.handoffSession.mockRejectedValue(new Error("handoff exploded"));
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Hand Off" }));

    await waitFor(() =>
      expect(rpc.showInfoMessage).toHaveBeenCalledWith("handoff exploded", InfoMessageType.error),
    );
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
  });

  it("remembers nothing when the handoff is cancelled", async () => {
    const repo = makeRepo();
    const { agentServers, controller } = renderProvider(repo);

    controller.request({ conversationId: "conversation:1", targetAgentServer: "claude-acp" });
    await fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(agentServers.setDefaultAgentServer).not.toHaveBeenCalled();
    expect(repo.handoffSession).not.toHaveBeenCalled();
  });
});
