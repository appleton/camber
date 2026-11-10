import { describe, expect, test, vi } from "vitest";
import { composeAcpTabIconSvg, sanitizeSvgForMask } from "./acpTabIcon";

vi.mock("vscode", () => ({}));

describe("acpTabIcon", () => {
  test("sanitizes an SVG for mask rendering", () => {
    const sanitized = sanitizeSvgForMask(
      `<svg viewBox="0 0 16 16"><path onclick="bad()" fill="#111" stroke="currentColor" d="M0 0h16v16H0z"/></svg>`,
    );

    expect(sanitized.viewBox).toBe("0 0 16 16");
    expect(sanitized.innerHTML).toContain(`fill="white"`);
    expect(sanitized.innerHTML).toContain(`stroke="white"`);
    expect(sanitized.innerHTML).not.toContain("onclick");
  });

  test("rejects unsafe SVG content", () => {
    expect(() =>
      sanitizeSvgForMask(`<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>`),
    ).toThrow(/unsupported element/);
    expect(() =>
      sanitizeSvgForMask(
        `<svg viewBox="0 0 16 16"><path href="https://example.com/icon.svg"/></svg>`,
      ),
    ).toThrow(/external references/);
  });

  test("composes the neutral agent mask with the status-colored camber badge", () => {
    const svg = composeAcpTabIconSvg(
      { viewBox: "0 0 16 16", innerHTML: `<path fill="white" d="M0 0h16v16H0z"/>` },
      {
        mainColor: "#757779",
        badge: { background: "#FFFFFF", foreground: "#3794FF" },
      },
    );

    expect(svg).toContain(`mask id="agent-mask"`);
    expect(svg).toContain(`fill="#757779" mask="url(#agent-mask)"`);
    expect(svg).toContain(`circle cx="12.5"`);
    expect(svg).toContain(`fill="#3794FF"`);
  });
});
