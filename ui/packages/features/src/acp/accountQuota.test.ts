import { camberAcpQuotaRead } from "@camber/helperapi";
import { get } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountQuota, getAccountQuota } from "./accountQuota";

vi.mock("@camber/helperapi", () => ({ camberAcpQuotaRead: vi.fn() }));

afterEach(() => vi.useRealTimers());

it("shares an in-flight quota read and the result across subscribers", async () => {
  vi.useFakeTimers();
  vi.mocked(camberAcpQuotaRead).mockResolvedValue({ buckets: [], availableResets: 2 });
  const pool = { connect: vi.fn().mockResolvedValue(undefined) };
  const firstQuota = getAccountQuota("codex-acp", pool);
  const secondQuota = getAccountQuota("codex-acp", pool);
  const first = vi.fn();
  const second = vi.fn();
  const unsubscribeFirst = firstQuota.subscribe(first);
  const unsubscribeSecond = secondQuota.subscribe(second);

  firstQuota.refresh();
  secondQuota.refresh();
  await vi.advanceTimersByTimeAsync(0);
  secondQuota.refresh();

  expect(camberAcpQuotaRead).toHaveBeenCalledExactlyOnceWith({ agentServer: "codex-acp" });
  expect(pool.connect).toHaveBeenCalledExactlyOnceWith("codex-acp");
  const result = { buckets: [], availableResets: 2, loading: false, unavailable: false };
  expect(first).toHaveBeenLastCalledWith(result);
  expect(second).toHaveBeenLastCalledWith(result);
  unsubscribeFirst();
  unsubscribeSecond();
});

it.each(["while reading", "during cooldown"])(
  "refreshes once after turn-end requests received %s",
  async (timing) => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ buckets: [], availableResets: 2 })
      .mockResolvedValueOnce({ buckets: [], availableResets: 1 });
    const quota = createAccountQuota(read);

    quota.refresh();
    if (timing === "during cooldown") await vi.advanceTimersByTimeAsync(0);
    quota.refresh(true);
    quota.refresh(true);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(get(quota).availableResets).toBe(1);
  },
);
