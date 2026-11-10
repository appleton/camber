import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../../../hostRpc";
import type { ToolCall } from "../../../types";
import ToolCallHarness from "./ImageGenerationToolCall.test.svelte";
import { getViewImagePreview, isViewImageToolCall } from "./viewImageTool";

vi.mock("../../../hostRpc", () => ({
  rpc: {
    openFile: vi.fn(),
    getImageFileData: vi.fn(),
  },
}));

describe("viewImageTool", () => {
  it("matches view_image calls with image output", () => {
    const tool = makeTool();

    expect(isViewImageToolCall(tool)).toBe(true);
    expect(getViewImagePreview(tool)).toEqual({
      src: `data:image/png;base64,${imageData}`,
      path: "/tmp/cat.png",
    });
  });

  it("does not match non-image view_image output", () => {
    expect(
      isViewImageToolCall({
        ...makeTool(),
        rawOutput: [{ type: "text", text: "not an image" }],
      }),
    ).toBe(false);
  });
});

describe("ViewImageToolCall", () => {
  beforeEach(() => {
    vi.mocked(rpc.openFile).mockReset();
    vi.mocked(rpc.getImageFileData).mockReset();
  });

  it("renders viewed images inline without raw output JSON", async () => {
    render(ToolCallHarness, {
      props: {
        event: makeTool(),
      },
    });

    expect(screen.getByText("View image")).toBeInTheDocument();
    expect(screen.queryByText(/image_url/)).not.toBeInTheDocument();
    const image = screen.getByAltText("Viewed image cat.png");
    expect(image).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    expect(image).toHaveAttribute("data-camber-image-path", "/tmp/cat.png");
    expect(image).toHaveAttribute("data-camber-image-name", "cat.png");

    await fireEvent.click(screen.getByRole("button", { name: "Open image file cat.png" }));

    expect(rpc.openFile).toHaveBeenCalledWith("/tmp/cat.png");
  });

  it("reads file:// image urls through the host instead of the DOM", async () => {
    vi.mocked(rpc.getImageFileData).mockResolvedValue({
      path: "/tmp/cat.png",
      mimeType: "image/png",
      data: imageData,
    });

    render(ToolCallHarness, {
      props: {
        event: {
          ...makeTool(),
          rawOutput: [
            { type: "input_image", detail: "original", image_url: "file:///tmp/cat.png" },
          ],
        },
      },
    });

    expect(rpc.getImageFileData).toHaveBeenCalledWith("/tmp/cat.png");
    expect(await screen.findByAltText("Viewed image cat.png")).toHaveAttribute(
      "src",
      `data:image/png;base64,${imageData}`,
    );
  });

  it("shows a fallback when the host cannot read a local image", async () => {
    vi.mocked(rpc.getImageFileData).mockResolvedValue(undefined);

    render(ToolCallHarness, {
      props: {
        event: {
          ...makeTool(),
          rawOutput: [
            { type: "input_image", detail: "original", image_url: "file:///tmp/cat.png" },
          ],
        },
      },
    });

    expect(await screen.findByText("Unable to preview image")).toBeInTheDocument();
  });
});

function makeTool(): ToolCall {
  return {
    eventKind: "tool_call",
    toolCallId: "call_123",
    title: "view_image",
    kind: "other",
    status: "completed",
    rawInput: { path: "/tmp/cat.png", detail: "original" },
    rawOutput: [
      {
        type: "input_image",
        detail: "original",
        image_url: `data:image/png;base64,${imageData}`,
      },
    ],
  };
}

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s8vH4QAAAAASUVORK5CYII=";
