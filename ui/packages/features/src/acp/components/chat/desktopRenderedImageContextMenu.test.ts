import { describe, expect, it, vi } from "vitest";
import {
  desktopRenderedImageTarget,
  imageFromContextMenuEvent,
  loadRenderedImageData,
} from "./desktopRenderedImageContextMenu";

describe("desktop rendered image context menu", () => {
  it("recognizes an image from a bubbling context-menu event", () => {
    const image = document.createElement("img");
    const event = new MouseEvent("contextmenu");
    Object.defineProperty(event, "target", { value: image });

    expect(imageFromContextMenuEvent(event)).toBe(image);
  });

  it("captures local path metadata and the workspace-relative path", () => {
    const image = document.createElement("img");
    image.src = "data:image/png;base64,aW1hZ2U=";
    image.dataset["camberImagePath"] = "/workspace/assets/photo.png";
    image.dataset["camberImageName"] = "/workspace/assets/photo.png";

    expect(desktopRenderedImageTarget(image, ["/workspace"])).toEqual({
      src: "data:image/png;base64,aW1hZ2U=",
      name: "photo.png",
      path: "/workspace/assets/photo.png",
      relativePath: "assets/photo.png",
    });
  });

  it("uses alt text to identify embedded images", () => {
    const image = document.createElement("img");
    image.src = "data:image/webp;base64,aW1hZ2U=";
    image.alt = "Generated result";

    expect(desktopRenderedImageTarget(image, [])).toEqual({
      src: "data:image/webp;base64,aW1hZ2U=",
      name: "Generated result",
      path: undefined,
      relativePath: undefined,
    });
  });

  it("reads an embedded image without fetching it again", async () => {
    const fetchImage = vi.fn();

    await expect(
      loadRenderedImageData("data:image/png;base64,aW1hZ2U=", fetchImage),
    ).resolves.toEqual({ data: "aW1hZ2U=", mimeType: "image/png" });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("reads a remote rendered image as base64", async () => {
    const fetchImage = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([105, 109, 97, 103, 101]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await expect(
      loadRenderedImageData("https://example.com/photo.png", fetchImage),
    ).resolves.toEqual({ data: "aW1hZ2U=", mimeType: "image/png" });
  });
});
