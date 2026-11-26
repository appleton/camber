import { camberAcpQuotaRead } from "@camber/helperapi";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import { rpc } from "../../hostRpc";
import QuotaUsageButton from "./QuotaUsageButton.svelte";

vi.mock("@camber/helperapi", () => ({ camberAcpQuotaRead: vi.fn() }));
vi.mock("../../hostRpc", () => ({ rpc: { openExternalURL: vi.fn() } }));

it("opens the account usage popover on click and shows each bucket", async () => {
  vi.mocked(camberAcpQuotaRead).mockResolvedValue({
    buckets: [
      { label: "5-hour limit", usedPercent: 0 },
      { label: "Weekly · Fable", usedPercent: 57.5 },
    ],
  });
  render(QuotaUsageButton, { agentServer: "claude-acp", hasSession: false, turnActive: false });

  const button = screen.getByRole("button", { name: "Account usage" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("progressbar")).toBeNull();

  await fireEvent.click(button);

  expect(await screen.findByRole("progressbar", { name: "5-hour limit" })).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("progressbar", { name: "Weekly · Fable" })).toHaveAttribute(
    "aria-valuenow",
    "57.5",
  );
  expect(camberAcpQuotaRead).toHaveBeenCalledWith({ agentServer: "claude-acp" });

  const dialog = screen.getByRole("dialog", { name: "Account usage" });
  await waitFor(() => expect(dialog).toHaveFocus());
  await fireEvent.keyDown(dialog, { key: "Escape" });

  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(button).toHaveFocus());
});

it("queues a background refresh when a turn ends during the cooldown", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(camberAcpQuotaRead).mockClear().mockResolvedValue({ buckets: [] });
    const view = render(QuotaUsageButton, {
      agentServer: "codex-acp",
      hasSession: true,
      turnActive: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await view.rerender({ turnActive: true });
    await view.rerender({ turnActive: false });

    expect(camberAcpQuotaRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(camberAcpQuotaRead).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["codex-acp", "https://chatgpt.com/settings/usage?tab=overview", 4, "4 resets available"],
  ["claude-acp", "https://claude.ai/settings/usage", 1, "1 reset available"],
  ["codex-acp", "https://chatgpt.com/settings/usage?tab=overview", 0, "Manage usage"],
  ["codex-acp", "https://chatgpt.com/settings/usage?tab=overview", undefined, "Manage usage"],
  ["claude-acp", "https://claude.ai/settings/usage", undefined, "Manage usage"],
])(
  "opens %s usage settings (%s) for reset count %s via %s",
  async (agentServer, url, availableResets, name) => {
    vi.mocked(rpc.openExternalURL).mockClear();
    vi.mocked(camberAcpQuotaRead).mockResolvedValue({
      buckets: [{ label: "5-hour limit", usedPercent: 10 }],
      availableResets,
    });
    render(QuotaUsageButton, { agentServer, hasSession: false, turnActive: false });

    await fireEvent.click(screen.getByRole("button", { name: "Account usage" }));
    await screen.findByRole("progressbar", { name: "5-hour limit" });
    const usageRow = screen.getByRole("button", { name });
    expect(screen.getByRole("separator")).toBeInTheDocument();

    await fireEvent.click(usageRow);
    expect(rpc.openExternalURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
