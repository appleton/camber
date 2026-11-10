import { describe, expect, it } from "vitest";
import {
  camberqaSlotForWorktree,
  camberqaSlotMobileUrl,
  type MobileCamberQAInstance,
} from "./camberqaMobile";

const instance: MobileCamberQAInstance = {
  slot: 1,
  worktreeName: "orderly-orbit",
  color: "#2563eb",
  slots: [
    { slot: 1, id: "orderly-orbit", remotePort: 8747 },
    { slot: 3, id: "brave-bison", remotePort: 8767 },
  ],
};

describe("camberqaSlotForWorktree", () => {
  it("matches a worktree served by another live slot", () => {
    const slot = camberqaSlotForWorktree({ name: "brave-bison", isWorktree: true }, instance);
    expect(slot).toEqual({ slot: 3, id: "brave-bison", remotePort: 8767 });
  });

  it("skips the slot already serving this app", () => {
    expect(camberqaSlotForWorktree({ name: "orderly-orbit", isWorktree: true }, instance)).toBe(
      null,
    );
  });

  it("skips worktrees with no live slot", () => {
    expect(camberqaSlotForWorktree({ name: "gone-tree", isWorktree: true }, instance)).toBe(null);
  });

  it("skips non-worktree projects and non-camberqa hosts", () => {
    expect(camberqaSlotForWorktree({ name: "brave-bison", isWorktree: false }, instance)).toBe(
      null,
    );
    expect(camberqaSlotForWorktree({ name: "brave-bison", isWorktree: true }, null)).toBe(null);
    expect(camberqaSlotForWorktree({ name: "brave-bison", isWorktree: true }, undefined)).toBe(
      null,
    );
  });
});

describe("camberqaSlotMobileUrl", () => {
  it("swaps only the port, keeping protocol and hostname", () => {
    const url = camberqaSlotMobileUrl(
      { remotePort: 8767 },
      { protocol: "https:", hostname: "mac.tail1234.ts.net" },
    );
    expect(url).toBe("https://mac.tail1234.ts.net:8767/");
  });

  it("keeps IPv6 brackets (Location.hostname includes them per the URL standard)", () => {
    // Mirrors what browsers hand us: new URL("https://[::1]:8747/").hostname === "[::1]".
    expect(new URL("https://[::1]:8747/").hostname).toBe("[::1]");
    const url = camberqaSlotMobileUrl(
      { remotePort: 8767 },
      { protocol: "https:", hostname: "[::1]" },
    );
    expect(url).toBe("https://[::1]:8767/");
  });

  it("appends the auth handoff fragment when provided", () => {
    const url = camberqaSlotMobileUrl(
      { remotePort: 8767 },
      { protocol: "https:", hostname: "mac.tail1234.ts.net" },
      "#camberDeviceToken=tok",
    );
    expect(url).toBe("https://mac.tail1234.ts.net:8767/#camberDeviceToken=tok");
  });
});
