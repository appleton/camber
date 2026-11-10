import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../../../hostRpc";
import type { ToolCall } from "../../../types";
import ToolCallHarness from "./ImageGenerationToolCall.test.svelte";

vi.mock("../../../hostRpc", () => ({
  rpc: {
    getImageFileData: vi.fn(),
    openFile: vi.fn(),
  },
}));

describe("ImageGenerationToolCall", () => {
  beforeEach(() => {
    vi.mocked(rpc.getImageFileData).mockReset();
    vi.mocked(rpc.openFile).mockReset();
  });

  it("renders generated images without expanding the tool details", () => {
    render(ToolCallHarness, {
      props: {
        event: {
          eventKind: "tool_call",
          toolCallId: "call_123",
          title: "Image generation",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: '"Revised prompt: A photorealistic cat by a sunlit window"',
              },
            },
            {
              type: "content",
              content: {
                type: "image",
                data: imageData,
                mimeType: "image/png",
                uri: "/tmp/cat.png",
              },
            },
          ],
        } satisfies ToolCall,
      },
    });

    expect(screen.getByText("Image generation")).toBeInTheDocument();
    expect(screen.queryByText(/Revised prompt/)).not.toBeInTheDocument();
    const image = screen.getByAltText("Generated result");
    expect(image).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    expect(image).toHaveAttribute("data-camber-image-path", "/tmp/cat.png");
    expect(image).toHaveAttribute("data-camber-image-name", "/tmp/cat.png");
  });

  it("opens the generated image file when the thumbnail is clicked", async () => {
    render(ToolCallHarness, {
      props: {
        event: {
          eventKind: "tool_call",
          toolCallId: "call_123",
          title: "Image generation",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "image",
                data: imageData,
                mimeType: "image/png",
                uri: "file:///tmp/cat.png",
              },
            },
          ],
        } satisfies ToolCall,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open generated image file" }));

    expect(rpc.openFile).toHaveBeenCalledWith("/tmp/cat.png");
  });

  it("renders an image-sized loading state while generation is pending", () => {
    render(ToolCallHarness, {
      props: {
        event: {
          eventKind: "tool_call",
          toolCallId: "call_123",
          title: "Image generation",
          status: "in_progress",
        } satisfies ToolCall,
      },
    });

    expect(screen.getByRole("status", { name: "Generating image" })).toBeInTheDocument();
  });
});

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s8vH4QAAAAASUVORK5CYII=";
