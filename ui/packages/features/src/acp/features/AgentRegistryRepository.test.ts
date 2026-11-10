import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentRegistryRepository } from "./AgentRegistryRepository.svelte";

describe("AcpAgentRegistryRepository", () => {
  beforeEach(() => localStorage.clear());

  it("coalesces overlapping checks and keeps the last list visible while checking or offline", async () => {
    const repo = new AcpAgentRegistryRepository("https://example.com/registry.json");
    const agent = { id: "codex", name: "Codex", version: "1.0.0", distribution: {} };
    await repo.load(vi.fn(async () => Response.json({ agents: [agent] })));
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = repo.load(fetcher);
    expect(repo.load(fetcher)).toBe(pending);
    await Promise.resolve();
    expect(repo.agents[0].version).toBe("1.0.0");
    resolve(Response.json({ agents: [{ ...agent, version: "1.1.0" }] }));
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://example.com/registry.json", {
      cache: "no-cache",
    });
    expect(repo.agents[0].version).toBe("1.1.0");
    localStorage.clear();
    await repo.load(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(repo.agents[0].version).toBe("1.1.0");
  });
  it("caches the latest registry response", async () => {
    localStorage.clear();
    const repo = new AcpAgentRegistryRepository("https://example.com/registry.json");

    await repo.load(
      vi.fn(async () =>
        Response.json({
          agents: [
            {
              id: "gemini",
              name: "Gemini",
              version: "1.0.0",
              description: "Gemini ACP",
              distribution: { npx: { package: "gemini-acp@1.0.0" } },
            },
          ],
        }),
      ),
    );

    expect(localStorage.getItem("camber.acp.agentRegistry")).toContain('"id":"gemini"');
  });

  it("falls back to the cached registry when fetching fails", async () => {
    localStorage.setItem(
      "camber.acp.agentRegistry",
      JSON.stringify({
        agents: [
          {
            id: "gemini",
            name: "Gemini",
            version: "1.0.0",
            description: "Gemini ACP",
            distribution: { npx: { package: "gemini-acp@1.0.0" } },
          },
        ],
      }),
    );
    const repo = new AcpAgentRegistryRepository("https://example.com/registry.json");

    await repo.load(vi.fn(async () => Promise.reject(new Error("offline"))));

    expect(repo.agents.map((agent) => agent.id)).toEqual(["gemini"]);
  });
});
