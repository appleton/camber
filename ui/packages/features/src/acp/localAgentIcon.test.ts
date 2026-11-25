import { describe, expect, it } from "vitest";
import { ACP_AGENT_REGISTRY_URL } from "./agentRegistry";
import { DEFAULT_AGENT_SERVER } from "./agentServers";
import { CAMBER_ROUNDEL_ICON_URL, agentServerIconUrl } from "./localAgentIcon";

describe("local agent icon", () => {
  it("resolves registry icons for ordinary agent servers", () => {
    expect(agentServerIconUrl("codex", { icon: "agent.svg" })).toBe(
      new URL("agent.svg", ACP_AGENT_REGISTRY_URL).toString(),
    );
    expect(agentServerIconUrl("local", undefined)).toBeUndefined();
    expect(agentServerIconUrl("custom", undefined)).toBeUndefined();
  });

  it("draws the first-party Camber agent from our own roundel, not the registry icon", () => {
    expect(agentServerIconUrl(DEFAULT_AGENT_SERVER, { icon: "ignored.svg" })).toBe(
      CAMBER_ROUNDEL_ICON_URL,
    );
    expect(agentServerIconUrl(DEFAULT_AGENT_SERVER, undefined)).toBe(CAMBER_ROUNDEL_ICON_URL);
  });

  it("exposes the detailed filled Camber brand roundel for branded surfaces", () => {
    const svg = decodeURIComponent(CAMBER_ROUNDEL_ICON_URL.replace("data:image/svg+xml,", ""));
    expect(svg).toContain('viewBox="0 0 16 16"');
    // Shrunk a hair about the artboard centre to match the sibling agent icons.
    expect(svg).toContain("scale(0.93)");
    // The filled brand mark from the app icon, not the stroke-only line glyph.
    expect(svg).toContain(BRAND_PATH_FRAGMENT);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain(ROUNDEL_PATH_FRAGMENT);
    expect(svg).not.toContain("badge-hole");
  });
});

const ROUNDEL_PATH_FRAGMENT = "M13.6135 10.7448";
const BRAND_PATH_FRAGMENT = "M2.79989 4.28935";
