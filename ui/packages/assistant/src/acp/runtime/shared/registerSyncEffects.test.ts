import { render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegisterSyncEffectsHarness from "./registerSyncEffects.test.svelte";

const refreshACPNavState = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const wireACPHistorySync = vi.hoisted(() => vi.fn(() => vi.fn()));
const wireACPSessionSync = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("@camber/features/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/features/acp")>()),
  refreshACPNavState,
  wireACPHistorySync,
  wireACPSessionSync,
}));

describe("registerSyncEffects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshACPNavState.mockClear();
    wireACPHistorySync.mockClear();
    wireACPSessionSync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes approvals at boot without polling them", async () => {
    const repositories = makeRepositories();
    const view = render(RegisterSyncEffectsHarness, {
      props: { repositories: repositories as never },
    });

    await waitFor(() => expect(repositories.acpRepo.refreshApprovals).toHaveBeenCalledTimes(1));

    // One combined nav refresh at boot (never per-repo refreshes, which would
    // duplicate the acpNav/list RPC), then one per poll tick.
    expect(refreshACPNavState).toHaveBeenCalledTimes(1);
    expect(repositories.acpProjectRepo.refresh).not.toHaveBeenCalled();
    expect(repositories.acpConversationRepo.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(refreshACPNavState).toHaveBeenCalledTimes(4);
    expect(repositories.acpRepo.refreshApprovals).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("refreshes the registry and installed agents without reopening settings", async () => {
    const repositories = makeRepositories();
    const view = render(RegisterSyncEffectsHarness, {
      props: { repositories: repositories as never },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(repositories.acpRegistry.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(repositories.acpRegistry.load).toHaveBeenCalledTimes(2);
    expect(repositories.acpAgentServers.refresh).toHaveBeenCalledTimes(2);
    expect(repositories.acpAgentServers.refresh).toHaveBeenLastCalledWith({ background: true });
    expect(repositories.acpAgentUpdates.refresh).toHaveBeenCalledTimes(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(repositories.acpRegistry.load).toHaveBeenCalledTimes(2);
  });
});

function makeRepositories() {
  return {
    acpRegistry: {
      load: vi.fn().mockResolvedValue(undefined),
    },
    acpAgentServers: {
      refresh: vi.fn().mockResolvedValue(undefined),
      configureSessionRepo: vi.fn(),
    },
    acpAgentUpdates: {
      refresh: vi.fn(),
    },
    acpLocalHistoryRepo: {
      setListSource: vi.fn(),
    },
    acpRepo: {
      emitter: new EventTarget(),
      refreshApprovals: vi.fn().mockResolvedValue(undefined),
      agents: {
        agentServerNames: [],
        connectServer: vi.fn(),
        getInitializeResponse: vi.fn(),
      },
    },
    acpConnectionPool: {
      debug: {
        capture: vi.fn(),
      },
    },
    acpConversationRepo: {
      emitter: new EventTarget(),
      hideSession: vi.fn(),
      showSession: vi.fn(),
      upsertConversation: vi.fn(),
      updateSessionTitle: vi.fn(),
      touchSession: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    acpProjectRepo: {
      refresh: vi.fn().mockResolvedValue(undefined),
    },
  };
}
