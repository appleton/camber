import {
  currentACPHostState,
  initializeACPHostRpc,
  setACPHostStateStore,
} from "@camber/features/acp";
import { failure, waiting } from "@camber/lib/async-state";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { writable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPAgentServersRepository } from "../../../features/src/acp/features/AgentServersRepository.svelte";
import Harness from "./AssistantConfigErrorBanner.test.svelte";

let hostMessageSender: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const initial = currentACPHostState();
  setACPHostStateStore(
    writable({
      ...initial,
      environment: {
        ...initial.environment,
        assistantHost: "vscode",
      },
      homeDirectory: "/Users/test",
    }),
  );
  hostMessageSender = vi.fn().mockResolvedValue(undefined);
  initializeACPHostRpc(hostMessageSender);
});

describe("AssistantConfigErrorBanner", () => {
  it("shows the config error and provides open, retry, and dismiss actions", async () => {
    const agentServers = agentServersRepository(
      failure(
        new Error(
          "assistant config: parsing /Users/test/.config/camber/assistant.json: invalid character",
        ),
      ),
    );

    render(Harness, { props: { agentServers } });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load assistant.json");
    expect(alert).toHaveTextContent("using the last successfully loaded agent configuration");
    expect(alert).toHaveTextContent("invalid character");

    await fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith("openFile", [
        "/Users/test/.config/camber/assistant.json",
      ]),
    );

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(agentServers.refresh).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays hidden when assistant.json has not failed to load", () => {
    render(Harness, { props: { agentServers: agentServersRepository(waiting) } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function agentServersRepository(
  state: ACPAgentServersRepository["state"],
): ACPAgentServersRepository {
  return {
    state,
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as ACPAgentServersRepository;
}
