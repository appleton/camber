import type { GitHubLinksOutput } from "@camber/helperapi";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../../hostAdapter";
import { initializeStatefulModule } from "../../hostRpc";
import { presentNativeMenu } from "../ui/menuSpec";
import DesktopGithubControl from "./DesktopGithubControl.svelte";

vi.mock("../ui/menuSpec", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  presentNativeMenu: vi.fn(),
}));

const mockPresentNativeMenu = vi.mocked(presentNativeMenu);

const links: GitHubLinksOutput = {
  supported: true,
  branch: "feature",
  repoUrl: "https://github.com/org/repo",
  pullsUrl: "https://github.com/org/repo/pulls",
  issuesUrl: "https://github.com/org/repo/issues",
  prUrl: "https://github.com/org/repo/pull/1",
  prExists: true,
};

const githubRepo = vi.hoisted(() => ({
  supportedFor: vi.fn(() => true),
  categoryFor: vi.fn(() => "none"),
  links: vi.fn(),
}));

vi.mock("../../features/GithubRepository.svelte", () => ({
  getACPGithubRepo: () => githubRepo,
}));

function setEnvironment(assistantHost: string, operatingSystem?: string): void {
  appState.update((state) => ({
    ...state,
    environment: { ...state.environment, assistantHost, operatingSystem },
  }));
}

describe("DesktopGithubControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubRepo.supportedFor.mockReturnValue(true);
    githubRepo.categoryFor.mockReturnValue("none");
    githubRepo.links.mockResolvedValue(links);
    initializeStatefulModule(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    setEnvironment("", undefined);
  });

  describe("DOM fallback", () => {
    it("opens the DOM menu and reports the clicked action's URL", async () => {
      const sender = vi.fn().mockResolvedValue(undefined);
      initializeStatefulModule(sender);

      render(DesktopGithubControl, { props: { targetPath: "/repo" } });

      await fireEvent.click(screen.getByRole("button", { name: "GitHub actions" }));
      await waitFor(() => expect(githubRepo.links).toHaveBeenCalledWith("/repo"));

      const issuesRow = await screen.findByRole("menuitem", { name: "Open Issues" });
      await fireEvent.click(issuesRow);

      expect(sender).toHaveBeenCalledWith("openExternalURL", [links.issuesUrl]);
      expect(mockPresentNativeMenu).not.toHaveBeenCalled();
    });

    it("disables every row while GitHub links are loading", async () => {
      let resolveLinks: (value: GitHubLinksOutput) => void = () => {};
      githubRepo.links.mockReturnValue(
        new Promise((resolve) => {
          resolveLinks = resolve;
        }),
      );

      render(DesktopGithubControl, { props: { targetPath: "/repo" } });

      await fireEvent.click(screen.getByRole("button", { name: "GitHub actions" }));

      expect(screen.getByRole("menuitem", { name: /Open Issues/ })).toBeDisabled();

      resolveLinks(links);
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: /Open Issues/ })).not.toBeDisabled(),
      );
    });
  });

  describe("native menu host", () => {
    it("presents the native menu from the trigger and dispatches the selected action", async () => {
      setEnvironment("desktop", "darwin");
      mockPresentNativeMenu.mockResolvedValue("openIssues");
      const sender = vi.fn().mockResolvedValue(undefined);
      initializeStatefulModule(sender);

      render(DesktopGithubControl, { props: { targetPath: "/repo" } });

      const trigger = screen.getByRole("button", { name: "GitHub actions" });
      await fireEvent.click(trigger);

      await waitFor(() => expect(mockPresentNativeMenu).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(sender).toHaveBeenCalledWith("openExternalURL", [links.issuesUrl]),
      );

      // No DOM menu renders; the OS owns the surface.
      expect(screen.queryByRole("menuitem")).toBeNull();

      const [items, anchor, options] = mockPresentNativeMenu.mock.calls[0];
      expect(options).toMatchObject({ highlightStyle: "themed" });
      expect(anchor).toMatchObject({ align: "end" });
      expect(items).toEqual([
        {
          kind: "action",
          id: "openPr",
          label: "Open Current PR",
          icon: "git-branch",
          enabled: true,
        },
        {
          kind: "action",
          id: "openPulls",
          label: "Open All Pull Requests",
          icon: "review",
          enabled: true,
        },
        { kind: "action", id: "openIssues", label: "Open Issues", icon: "alert", enabled: true },
        { kind: "action", id: "openRepo", label: "Open Repository", icon: "github", enabled: true },
      ]);

      // Reflects open state on the trigger while the native menu is up, then
      // clears it once presentNativeMenu resolves.
      await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    });

    it("does not dispatch when the native menu is dismissed", async () => {
      setEnvironment("desktop", "darwin");
      mockPresentNativeMenu.mockResolvedValue(undefined);
      const sender = vi.fn().mockResolvedValue(undefined);
      initializeStatefulModule(sender);

      render(DesktopGithubControl, { props: { targetPath: "/repo" } });

      await fireEvent.click(screen.getByRole("button", { name: "GitHub actions" }));
      await waitFor(() => expect(mockPresentNativeMenu).toHaveBeenCalledTimes(1));

      expect(sender).not.toHaveBeenCalledWith("openExternalURL", expect.anything());
    });
  });
});
