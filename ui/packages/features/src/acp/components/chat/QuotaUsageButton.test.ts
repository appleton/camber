import { camberAcpQuotaRead } from "@camber/helperapi";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import QuotaUsageButton from "./QuotaUsageButton.svelte";

vi.mock("@camber/helperapi", () => ({ camberAcpQuotaRead: vi.fn() }));

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

  await fireEvent.keyDown(screen.getByRole("dialog", { name: "Account usage" }), { key: "Escape" });

  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "false");
});
