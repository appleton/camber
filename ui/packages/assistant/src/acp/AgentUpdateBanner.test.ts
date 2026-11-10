import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import {
  ACPAgentUpdateRepository,
  type ACPAgentUpdateRepositoryOptions,
} from "../../../features/src/acp/features/AgentUpdateRepository.svelte";
import Harness from "./AgentUpdateBanner.test.svelte";

describe("AgentUpdateBanner", () => {
  it("shows a later release even after the previous update was dismissed", async () => {
    const updates = new ACPAgentUpdateRepository({} as ACPAgentUpdateRepositoryOptions);
    const update = updateRepository().updateFor("poolside")!;
    updates.updates = [update];
    render(Harness, { props: { updates } });
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Update agent" })).toBeNull();
    updates.updates = [{ ...update, agent: { ...update.agent, version: "1.0.14" } }];
    expect(await screen.findByRole("button", { name: "Update agent" })).toBeVisible();
  });

  it("offers a restart for an update that is already installed", async () => {
    const updates = updateRepository("restart");
    vi.mocked(updates.update).mockResolvedValueOnce(undefined);
    render(Harness, { props: { updates } });
    expect(screen.getByText("Restart required for the Camber agent")).toBeVisible();
    expect(screen.getByText(/Version 1.0.13 is installed/)).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));
    expect(updates.update).toHaveBeenCalledWith("poolside");
    expect(screen.queryByRole("button", { name: "Update agent" })).toBeNull();
  });

  it("keeps restart disabled while that agent has running conversations", () => {
    const updates = updateRepository("restart");
    vi.mocked(updates.restartBlockedFor).mockReturnValue(true);
    render(Harness, { props: { updates } });
    expect(screen.getByRole("button", { name: "Restart agent" })).toBeDisabled();
    expect(screen.getByText(/Wait for this agent’s running conversations/)).toBeVisible();
  });

  it("shows update failures and allows retrying", async () => {
    const updates = updateRepository();

    render(Harness, { props: { updates } });
    await fireEvent.click(screen.getByRole("button", { name: "Update agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t update the Camber agent to version 1.0.13.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("unexpected sha256 property");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(updates.update).toHaveBeenCalledTimes(2);
  });
});

function updateRepository(kind = "update"): ACPAgentUpdateRepository {
  const repository = {
    busyAgentServer: null,
    error: null as string | null,
    updateFor: vi.fn(() => ({
      agentServer: "poolside",
      agent: {
        id: "poolside",
        name: "Camber",
        version: "1.0.13",
        description: "Camber ACP agent",
        distribution: { binary: {} },
      },
      kind,
      currentConfig: {},
      nextConfig: {},
    })),
    progressFor: vi.fn(() => null),
    restartBlockedFor: vi.fn(() => false),
    busyLabel: vi.fn(() => "Updating"),
    update: vi.fn(async () => {
      const message = "unexpected sha256 property";
      repository.error = message;
      throw new Error(message);
    }),
  };
  return repository as unknown as ACPAgentUpdateRepository;
}
