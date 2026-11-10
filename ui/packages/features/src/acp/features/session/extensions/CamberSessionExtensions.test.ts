import { describe, expect, it } from "vitest";
import { CamberSessionExtensions } from "./CamberSessionExtensions.svelte";

describe("CamberSessionExtensions", () => {
  it("ignores a completion for a different compaction", () => {
    const extensions = new CamberSessionExtensions();

    extensions.handleCompactionUpdate({ id: "active", phase: "started" });
    extensions.handleCompactionUpdate({ id: "stale", phase: "completed" });

    expect(extensions.compacting).toBe(true);

    extensions.handleCompactionUpdate({ id: "active", phase: "completed" });
    expect(extensions.compacting).toBe(false);
  });

  it("clears an unterminated compaction when the turn ends", () => {
    const extensions = new CamberSessionExtensions();
    extensions.handleCompactionUpdate({ id: "failed", phase: "started" });

    extensions.endTurn();

    expect(extensions.compacting).toBe(false);
  });
});
