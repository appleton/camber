import { render, waitFor } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../../types";
import ToolCallContentsHarness from "./ToolCallContents.test.svelte";

// jsdom cannot host @pierre/diffs' shadow-DOM renderer; swap PatchDiff for a
// stub that renders the new-side text so assertions still see each block's
// own content.
vi.mock("@camber/components/file-diff", async () => ({
  PatchDiff: (await import("./PatchDiff.mock.svelte")).default,
}));

describe("ToolCallContents", () => {
  beforeAll(() => {
    // jsdom has no Web Animations API; CollapsibleContent's reveal transition needs it.
    Element.prototype.animate = vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      finish: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      reverse: vi.fn(),
    }));
  });

  // A multi-hunk Edit arrives as several diff content blocks (one per
  // structuredPatch hunk). Each block must render its own hunk rather than
  // the ambient Diff context ToolRoot builds from the first block, which
  // would show hunk #1 once per block and drop the rest.
  it("renders each diff content block's own hunk without delaying small diffs", async () => {
    const tool: ToolCall = {
      eventKind: "tool_call",
      toolCallId: "call_edit_multi",
      title: "Edit `virtualWindow.ts`",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/repo/virtualWindow.ts",
          oldText: "let topPad = 0;",
          newText: "let topPad = 0;\nlet hunkOneAddition = 0;",
        },
        {
          type: "diff",
          path: "/repo/virtualWindow.ts",
          oldText: "end = i;",
          newText: "end = i;\nhunkTwoAddition = itemBottom;",
        },
      ],
    };

    const { container } = render(ToolCallContentsHarness, { props: { tool } });
    expect(container.textContent).not.toContain("Preparing diff…");
    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("hunkTwoAddition");
      expect(text.match(/hunkOneAddition/g)).toHaveLength(1);
    });
  });

  it("yields a paint before mounting a large diff", async () => {
    const unchanged = "const unchanged = true;\n".repeat(500);
    const tool: ToolCall = {
      eventKind: "tool_call",
      toolCallId: "call_edit_large",
      title: "Edit `large.ts`",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/repo/large.ts",
          oldText: `${unchanged}const result = "before";`,
          newText: `${unchanged}const result = "after";`,
        },
      ],
    };

    const { container } = render(ToolCallContentsHarness, { props: { tool } });
    expect(container.textContent).toContain("Preparing diff…");
    await waitFor(() => expect(container.textContent).toContain('const result = "after";'));
  });
});
