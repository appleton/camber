import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DesktopWorktreeBranchPrefixSection from "./DesktopWorktreeBranchPrefixSection.svelte";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock("@camber/helperapi", () => ({
  camberAcpNavGetWorktreeBranchPrefix: api.get,
  camberAcpNavSetWorktreeBranchPrefix: api.set,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DesktopWorktreeBranchPrefixSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ prefix: "camber/" });
  });

  it("saves a commit made while an earlier save is in flight", async () => {
    const first = deferred<{ prefix: string }>();
    api.set.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ prefix: "b/" });
    render(DesktopWorktreeBranchPrefixSection);
    const input = (await screen.findByPlaceholderText("No prefix")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("camber/"));

    await fireEvent.input(input, { target: { value: "a/" } });
    await fireEvent.change(input);
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ prefix: "a/" }));

    await fireEvent.input(input, { target: { value: "b/" } });
    await fireEvent.change(input);
    expect(api.set).toHaveBeenCalledTimes(1);

    first.resolve({ prefix: "a/" });
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ prefix: "b/" }));
    await waitFor(() => expect(input.value).toBe("b/"));
    expect(api.set).toHaveBeenCalledTimes(2);
  });

  it("saves a queued correction when the in-flight save fails", async () => {
    const first = deferred<{ prefix: string }>();
    api.set.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ prefix: "good/" });
    render(DesktopWorktreeBranchPrefixSection);
    const input = (await screen.findByPlaceholderText("No prefix")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("camber/"));

    await fireEvent.input(input, { target: { value: "bad" } });
    await fireEvent.change(input);
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ prefix: "bad" }));
    await fireEvent.input(input, { target: { value: "good/" } });
    await fireEvent.change(input);

    first.reject(new Error("invalid prefix"));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith({ prefix: "good/" }));
    await waitFor(() => expect(input.value).toBe("good/"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error when a save fails with nothing queued", async () => {
    api.set.mockRejectedValueOnce(new Error("invalid prefix"));
    render(DesktopWorktreeBranchPrefixSection);
    const input = (await screen.findByPlaceholderText("No prefix")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("camber/"));

    await fireEvent.input(input, { target: { value: "bad" } });
    await fireEvent.change(input);
    expect((await screen.findByRole("alert")).textContent).toContain("invalid prefix");
    expect(api.set).toHaveBeenCalledTimes(1);
  });
});
