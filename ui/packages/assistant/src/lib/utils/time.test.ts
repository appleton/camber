import { withTimeout } from "@camber/components/assistant-ui";
import { describe, expect, it } from "vitest";

describe("withTimeout", () => {
  it("resolves when callback calls resolver before timeout", async () => {
    const val = "hello!";

    const res = await withTimeout((resolve) => {
      resolve();
      return val;
    }, 10);

    expect(res).toBe(val);
  });

  it("resolves when callback does not call resolver before timeout", async () => {
    const val = "hello!";
    const res = await withTimeout(() => val, 10);
    expect(res).toBe(val);
  });
});
