import { describe, expect, it } from "vitest";
import { ACP_AGENT_REGISTRY_URL } from "./agentRegistry";
import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "./agentServers";
import {
  CAMBER_ROUNDEL_ICON_URL,
  LOCAL_AGENT_ICON_URL,
  LOCAL_AGENT_ROUNDEL_ICON_URL,
  LOCAL_AGENT_SYSTEM_ICON_URL,
  agentServerIconUrl,
} from "./localAgentIcon";

describe("local agent icon", () => {
  it("composes the local agent roundel and system badge as an encoded SVG", () => {
    expect(LOCAL_AGENT_ICON_URL.startsWith("data:image/svg+xml,")).toBe(true);

    const svg = decodeURIComponent(LOCAL_AGENT_ICON_URL.replace("data:image/svg+xml,", ""));
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('mask id="badge-hole"');
    expect(svg).toContain('mask="url(#badge-hole)"');
    expect(svg).toContain('transform="translate(6 6) scale(0.625)"');
  });

  it("uses the composed icon only for the local agent server", () => {
    expect(agentServerIconUrl(LOCAL_AGENT_SERVER, { icon: "ignored.svg" })).toBe(
      LOCAL_AGENT_ICON_URL,
    );
    expect(agentServerIconUrl("codex", { icon: "agent.svg" })).toBe(
      new URL("agent.svg", ACP_AGENT_REGISTRY_URL).toString(),
    );
    expect(agentServerIconUrl("custom", undefined)).toBeUndefined();
  });

  it("draws the first-party Camber agent from our own roundel, not the registry icon", () => {
    expect(agentServerIconUrl(DEFAULT_AGENT_SERVER, { icon: "ignored.svg" })).toBe(
      CAMBER_ROUNDEL_ICON_URL,
    );
    expect(agentServerIconUrl(DEFAULT_AGENT_SERVER, undefined)).toBe(CAMBER_ROUNDEL_ICON_URL);
  });

  it("exposes separate local-agent layers for two-colour picker rendering", () => {
    const roundel = decodeSvg(LOCAL_AGENT_ROUNDEL_ICON_URL);
    const system = decodeSvg(LOCAL_AGENT_SYSTEM_ICON_URL);

    expect(roundel).toContain('mask id="badge-hole"');
    // The badged roundel now uses the same filled brand mark as the plain icon.
    expect(roundel).toContain(BRAND_PATH_FRAGMENT);
    expect(roundel).not.toContain('transform="translate(6 6) scale(0.625)"');
    expect(system).not.toContain(BRAND_PATH_FRAGMENT);
    expect(system).toContain('transform="translate(6 6) scale(0.625)"');
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

function decodeSvg(url: string): string {
  return decodeURIComponent(url.replace("data:image/svg+xml,", ""));
}
