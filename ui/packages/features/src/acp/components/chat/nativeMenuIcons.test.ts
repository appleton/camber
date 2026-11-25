import { afterEach, describe, expect, it, vi } from "vitest";
import { starIconsFor, wireIconFor } from "./nativeMenuIcons";

// jsdom neither loads images nor implements 2D canvas, so the rasterizing
// tests stub both: Image resolves immediately and the canvas records the
// draw/fill calls, encoding to a fixed base64 marker.
function stubRasterization() {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 16;
      naturalHeight = 16;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    globalCompositeOperation: "source-over",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,RASTERIZED",
  );
  return context;
}

describe("wireIconFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rasterizes glyph names in color", async () => {
    const context = stubRasterization();

    await expect(wireIconFor("delete", { iconColor: "#112233" })).resolves.toEqual({
      pngBase64: "RASTERIZED",
    });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("memoizes per glyph and color, rasterizing anew for a different color", async () => {
    const context = stubRasterization();

    await wireIconFor("copy", { iconColor: "#101010" });
    await wireIconFor("copy", { iconColor: "#101010" });
    expect(context.drawImage).toHaveBeenCalledTimes(1);

    await wireIconFor("copy", { iconColor: "#202020" });
    expect(context.drawImage).toHaveBeenCalledTimes(2);
  });

  it("lets a per-icon color override the default", async () => {
    const context = stubRasterization();

    await expect(
      wireIconFor({ name: "trash", color: "#ff0001" }, { iconColor: "#303030" }),
    ).resolves.toEqual({ pngBase64: "RASTERIZED" });
    // Same name+color, different default: the explicit color keys the cache.
    await wireIconFor({ name: "trash", color: "#ff0001" }, { iconColor: "#404040" });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("rasterizes raw SVG markup in color", async () => {
    const context = stubRasterization();

    await expect(
      wireIconFor(
        {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="2" height="12" fill="currentColor"/></svg>',
          color: "#00ff01",
        },
        { iconColor: "#505050" },
      ),
    ).resolves.toEqual({ pngBase64: "RASTERIZED" });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined for markup that is not an SVG", async () => {
    stubRasterization();

    await expect(wireIconFor({ svg: "<div>not svg</div>" })).resolves.toBeUndefined();
  });

  it("passes file-path icons through for the OS to resolve, without rasterizing", async () => {
    // No canvas or Image stubs: a pure passthrough must touch neither (jsdom
    // would fail the build if it tried).
    await expect(wireIconFor({ file: "/Users/me/Projects/app" })).resolves.toEqual({
      filePath: "/Users/me/Projects/app",
    });
  });

  it("recolors URL icons as a flat mask, like the DOM's bg-current CSS mask", async () => {
    const context = stubRasterization();
    // A fresh Response per call: a body is single-use, and the explicit-color
    // variant below fetches again (its own cache entry).
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(new Blob(["png-bytes"], { type: "image/png" })),
    );
    // jsdom has no object URLs; patch them for the fetch->image handoff.
    const urlStatics = URL as typeof URL & {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const previousCreate = urlStatics.createObjectURL;
    const previousRevoke = urlStatics.revokeObjectURL;
    urlStatics.createObjectURL = vi.fn(() => "blob:mock");
    urlStatics.revokeObjectURL = vi.fn();

    try {
      await expect(
        wireIconFor({ url: "https://example.com/masked.png" }, { iconColor: "#123456" }),
      ).resolves.toEqual({ pngBase64: "RASTERIZED" });
      // The silhouette fill: everything drawn is recolored to the glyph color.
      expect(context.fillRect).toHaveBeenCalledTimes(1);
      expect(context.fillStyle).toBe("#123456");

      // An explicit per-icon color (agent brand tint) overrides the default
      // and keys its own cache entry.
      await expect(
        wireIconFor(
          { url: "https://example.com/masked.png", color: "#d97757" },
          { iconColor: "#123456" },
        ),
      ).resolves.toEqual({ pngBase64: "RASTERIZED" });
      expect(context.fillRect).toHaveBeenCalledTimes(2);
      expect(context.fillStyle).toBe("#d97757");
    } finally {
      urlStatics.createObjectURL = previousCreate;
      urlStatics.revokeObjectURL = previousRevoke;
    }
  });

  it("loads data: URI masks through <img> without fetching", async () => {
    const context = stubRasterization();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      wireIconFor(
        { url: 'data:image/svg+xml,<svg data-test="mask-base"/>' },
        { iconColor: "#abcdef" },
      ),
    ).resolves.toEqual({ pngBase64: "RASTERIZED" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(context.fillRect).toHaveBeenCalledTimes(1);
    expect(context.fillStyle).toBe("#abcdef");
  });

  it("rasterizes full-color image icons without masking or fetching", async () => {
    const context = stubRasterization();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      wireIconFor({ image: "data:image/png;base64,QUJD" }, { iconColor: "#123456" }),
    ).resolves.toEqual({ pngBase64: "RASTERIZED" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    // The artwork keeps its own colors: no silhouette fill.
    expect(context.fillRect).not.toHaveBeenCalled();

    // Color never enters the raster, so a different default hits the cache.
    await wireIconFor({ image: "data:image/png;base64,QUJD" }, { iconColor: "#fedcba" });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("upscales padded image artwork about the center when a scale is given", async () => {
    const context = stubRasterization();

    await wireIconFor({ image: "data:image/png;base64,U0NBTEU=", scale: 1.25 });

    // 16px surface, 16px image: contain fit is 1, so 1.25 draws 20px at -2,-2.
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(expect.anything(), -2, -2, 20, 20);
  });

  it("resolves undefined instead of rejecting when an image icon fails to load", async () => {
    stubRasterization();
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );

    await expect(wireIconFor({ image: "data:image/png;base64,QlJPS0VO" })).resolves.toBeUndefined();
  });

  it("resolves undefined instead of rejecting when a URL icon fails to load", async () => {
    stubRasterization();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(wireIconFor({ url: "https://example.com/agent.png" })).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined instead of rejecting when the glyph image fails to load", async () => {
    stubRasterization();
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );

    await expect(wireIconFor("roundel")).resolves.toBeUndefined();
  });

  it("fails fast (resolving undefined) where 2D canvas is unavailable", async () => {
    // No stubs: jsdom's getContext("2d") returns null, and the surface is
    // created before any image load is awaited, so this must not hang.
    await expect(wireIconFor("bolt")).resolves.toBeUndefined();
  });

  it("rasterizes the same icon anew when the devicePixelRatio changes", async () => {
    const context = stubRasterization();

    await wireIconFor("plan", { iconColor: "#606060" });
    expect(context.drawImage).toHaveBeenCalledTimes(1);

    // The window moved to a 2x display: the 1x bitmap is stale, so the icon
    // rasterizes again at the new resolution.
    vi.stubGlobal("devicePixelRatio", 2);
    await wireIconFor("plan", { iconColor: "#606060" });
    expect(context.drawImage).toHaveBeenCalledTimes(2);

    // Same DPR again hits the cache.
    await wireIconFor("plan", { iconColor: "#606060" });
    expect(context.drawImage).toHaveBeenCalledTimes(2);
  });

  // Deadline and cache-eviction behavior. Fake timers are restricted to the
  // timer APIs the deadline uses: faking everything would also fake
  // requestAnimationFrame and clobber unrelated machinery.
  describe("build deadline", () => {
    // jsdom has no object URLs; patch them for the fetch → image handoff.
    function stubObjectUrls(): () => void {
      const urlStatics = URL as typeof URL & {
        createObjectURL?: (blob: Blob) => string;
        revokeObjectURL?: (url: string) => void;
      };
      const previousCreate = urlStatics.createObjectURL;
      const previousRevoke = urlStatics.revokeObjectURL;
      urlStatics.createObjectURL = vi.fn(() => "blob:mock");
      urlStatics.revokeObjectURL = vi.fn();
      return () => {
        urlStatics.createObjectURL = previousCreate;
        urlStatics.revokeObjectURL = previousRevoke;
      };
    }

    it("resolves undefined at the deadline and aborts the hung fetch", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        stubRasterization();
        // A remote icon fetch that hangs forever must not hang the caller
        // (and with it every future menu open awaiting this icon).
        let signal: AbortSignal | null | undefined;
        vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
          signal = init?.signal;
          return new Promise(() => {});
        });

        const pending = wireIconFor({ url: "https://example.com/hung.png" });
        await vi.advanceTimersByTimeAsync(1500);
        await expect(pending).resolves.toBeUndefined();
        // The deadline gave up on the build, so its fetch is torn down too.
        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("evicts a rejected build so the next open retries, leaving no stray timer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const restoreUrls = stubObjectUrls();
      try {
        stubRasterization();
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockRejectedValueOnce(new Error("offline"))
          .mockImplementation(
            async () => new Response(new Blob(["png-bytes"], { type: "image/png" })),
          );

        await expect(
          wireIconFor({ url: "https://example.com/flaky.png" }),
        ).resolves.toBeUndefined();
        // The rejection settled the race, so its deadline timer is cleared.
        expect(vi.getTimerCount()).toBe(0);

        // The failure was not cached: the next open retries and succeeds.
        await expect(wireIconFor({ url: "https://example.com/flaky.png" })).resolves.toEqual({
          pngBase64: "RASTERIZED",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        restoreUrls();
        vi.useRealTimers();
      }
    });

    it("evicts a timed-out build so the next open re-fetches instead of awaiting the corpse", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const restoreUrls = stubObjectUrls();
      try {
        const context = stubRasterization();
        // The first fetch hangs until its abort signal fires (as a real fetch
        // would); the retry succeeds immediately.
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementationOnce(
            (_input, init) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                  reject(new DOMException("Aborted", "AbortError")),
                );
              }),
          )
          .mockImplementation(
            async () => new Response(new Blob(["png-bytes"], { type: "image/png" })),
          );

        // The first open pays the deadline and presents without the icon...
        const first = wireIconFor({ url: "https://example.com/timeout.png" });
        await vi.advanceTimersByTimeAsync(1500);
        await expect(first).resolves.toBeUndefined();

        // ...and the hung build is evicted, so the next open starts a fresh
        // build that succeeds right away — no timer advance needed, proving
        // it is not stuck awaiting the timed-out corpse for another 1500ms.
        await expect(wireIconFor({ url: "https://example.com/timeout.png" })).resolves.toEqual({
          pngBase64: "RASTERIZED",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(context.drawImage).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        restoreUrls();
        vi.useRealTimers();
      }
    });

    it("evicts a hung non-fetch build at the deadline so nothing pends forever in the cache", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        stubRasterization();
        // Glyph builds load via Image, which has no abort; the deadline can
        // only evict the pending entry. The first load hangs forever, later
        // loads succeed.
        let hangLoads = true;
        vi.stubGlobal(
          "Image",
          class {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 16;
            naturalHeight = 16;
            set src(_value: string) {
              if (!hangLoads) queueMicrotask(() => this.onload?.());
            }
          },
        );

        const first = wireIconFor("plan", { iconColor: "#717171" });
        await vi.advanceTimersByTimeAsync(1500);
        await expect(first).resolves.toBeUndefined();

        // Evicted at the deadline: the next open rebuilds and succeeds
        // instead of awaiting the hung load (a late settle of the orphaned
        // build would be harmless — it is no longer cached).
        hangLoads = false;
        await expect(wireIconFor("plan", { iconColor: "#717171" })).resolves.toEqual({
          pngBase64: "RASTERIZED",
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a settled success cached past the deadline for later opens", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const restoreUrls = stubObjectUrls();
      try {
        const context = stubRasterization();
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(
            async () => new Response(new Blob(["png-bytes"], { type: "image/png" })),
          );

        await expect(wireIconFor({ url: "https://example.com/fast.png" })).resolves.toEqual({
          pngBase64: "RASTERIZED",
        });
        // Well past the deadline: eviction only targets still-pending builds,
        // so the settled icon still serves from the cache with no new fetch
        // or raster pass.
        await vi.advanceTimersByTimeAsync(3000);
        await expect(wireIconFor({ url: "https://example.com/fast.png" })).resolves.toEqual({
          pngBase64: "RASTERIZED",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(context.drawImage).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        restoreUrls();
        vi.useRealTimers();
      }
    });
  });
});

describe("starIconsFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rasterizes the star glyph once per state color", async () => {
    const context = stubRasterization();

    await expect(
      starIconsFor({ pinned: "#00ffcc", normal: "#999999", hover: "#eeeeee" }),
    ).resolves.toEqual({
      pinned: "RASTERIZED",
      normal: "RASTERIZED",
      hover: "RASTERIZED",
    });
    // One raster pass per state — pinned, normal, and hover each draw.
    expect(context.drawImage).toHaveBeenCalledTimes(3);
  });

  it("resolves undefined instead of rejecting when rasterization is unavailable", async () => {
    // No 2D canvas (e.g. a headless webview): the menu simply presents
    // without star icons rather than failing to open.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    await expect(
      starIconsFor({ pinned: "#00ffcc", normal: "#999999", hover: "#eeeeee" }),
    ).resolves.toBeUndefined();
  });
});
