import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import {
  ACPSessionRepositoryWriter,
  type ACPSessionRepository,
} from "../../features/SessionRepository.svelte";
import { CODEX_GOAL_CONTROL_METHOD, type ACPGoalState } from "../../goals";
import { appState } from "../../hostAdapter";
import Harness from "./GoalIndicator.test.svelte";

function makeRepo(
  goal: ACPGoalState | null,
  actions: {
    pauseGoal?: () => Promise<void>;
    resumeGoal?: () => Promise<void>;
    clearGoal?: () => Promise<void>;
  } = {},
): ACPSessionRepository {
  return {
    getSessionByConversationId: () => ({
      goal,
      pendingGoalAction: null,
      goalActionError: null,
      pauseGoal: vi.fn().mockResolvedValue(undefined),
      resumeGoal: vi.fn().mockResolvedValue(undefined),
      clearGoal: vi.fn().mockResolvedValue(undefined),
      ...actions,
    }),
  } as unknown as ACPSessionRepository;
}

describe("GoalIndicator", () => {
  it("renders nothing without an active goal", () => {
    render(Harness, { props: { repo: makeRepo(null) } });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an active objective and its details", async () => {
    const goal: ACPGoalState = {
      source: "codex",
      objective: "Fix every remaining integration test",
      status: "active",
      controlMethod: CODEX_GOAL_CONTROL_METHOD,
      timeUsedSeconds: 482,
      tokenBudget: 50_000,
    };
    render(Harness, { props: { repo: makeRepo(goal) } });

    const chip = screen.getByRole("button", {
      name: "Goal, Active: Fix every remaining integration test",
    });
    expect(chip).toHaveTextContent(goal.objective);
    chip.focus();
    await fireEvent.click(chip);
    await tick();

    expect(screen.getByText("8m")).toBeInTheDocument();
    expect(screen.getByText(/50K token budget/i)).toBeInTheDocument();
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("Goal", { exact: true })).not.toBeInTheDocument();
    const status = within(menu).getByText("Active");
    const statusRow = status.parentElement;
    const objective = within(menu).getByText(goal.objective);
    const pause = screen.getByRole("menuitem", { name: "Pause goal" });
    const clear = screen.getByRole("menuitem", { name: "Clear goal" });
    expect(chip).toHaveFocus();
    expect(pause).not.toHaveFocus();
    expect(clear).not.toHaveFocus();
    expect(statusRow?.firstElementChild).toBe(status);
    expect(statusRow).toContainElement(pause);
    expect(statusRow).toContainElement(clear);
    expect(statusRow?.nextElementSibling).toBe(objective);
    expect(objective).not.toContainElement(pause);
    expect(objective).not.toContainElement(clear);
    expect(pause.closest("div")).toHaveClass("gap-0");
    expect(pause).toHaveClass("size-6", "rounded-full");
    expect(clear).toHaveClass("size-6", "rounded-full");
    expect(pause).toHaveClass("bg-transparent", "hover:bg-psx-chrome-hover");
    expect(clear).toHaveClass("bg-transparent", "hover:bg-psx-chrome-hover");
    expect(pause).not.toHaveClass("border");
    expect(clear).not.toHaveClass("border");
    expect(pause.textContent).toBe("");
    expect(clear.textContent).toBe("");
    expect(pause.querySelector("path")?.getAttribute("d")).toContain("M6.5 6V10");
    expect(pause.querySelector("svg")).toHaveAttribute("width", "16");
    expect(clear.querySelector("path")?.getAttribute("d")).toContain("M14.3334 7.99984");
    expect(clear.querySelector("svg")).toHaveAttribute("width", "16");
    expect(clear.querySelector("rect")).toHaveAttribute("width", "5");
  });

  it.each<ACPGoalState["status"]>([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ])("keeps the goal target icon while its status is %s", (status) => {
    const { container } = render(Harness, {
      props: {
        repo: makeRepo({
          source: "codex",
          objective: "Ship the release",
          status,
        }),
      },
    });

    expect(container.querySelector("button svg")?.getAttribute("overflow")).toBe("visible");
    const targetPaths = Array.from(container.querySelectorAll("button path"), (path) =>
      path.getAttribute("d"),
    ).join(" ");
    expect(targetPaths).toContain("M9.2 6.8L6.5 9.5");
    expect(targetPaths).toContain(
      "M11.3 2.3L8.75 4.85V6.35L9.65 7.25H11.15L13.7 4.7L10.588 5.412L11.3 2.3Z",
    );
  });

  it("resumes a paused Codex goal", async () => {
    const resumeGoal = vi.fn().mockResolvedValue(undefined);
    render(Harness, {
      props: {
        repo: makeRepo(
          {
            source: "codex",
            objective: "Finish the migration",
            status: "paused",
            controlMethod: CODEX_GOAL_CONTROL_METHOD,
          },
          { resumeGoal },
        ),
      },
    });

    const chip = screen.getByRole("button", { name: "Goal, Paused: Finish the migration" });
    expect(chip).toHaveTextContent("Goal paused");
    await fireEvent.click(chip);
    const status = screen.getByText("Paused");
    const statusRow = status.parentElement;
    const resume = screen.getByRole("menuitem", { name: "Resume goal" });
    const clear = screen.getByRole("menuitem", { name: "Clear goal" });
    expect(statusRow).toContainElement(resume);
    expect(statusRow).toContainElement(clear);
    expect(resume).toHaveClass("size-6", "rounded-full");
    expect(resume.textContent).toBe("");
    expect(
      Array.from(resume.querySelectorAll("path"), (path) => path.getAttribute("d")).join(" "),
    ).toContain("M6.04175 6.13087");
    await fireEvent.click(resume);

    expect(resumeGoal).toHaveBeenCalledOnce();
  });

  it("sizes the mobile sheet to the visual viewport and keeps a replacement goal closed", async () => {
    const previousAppState = get(appState);
    appState.set({
      ...previousAppState,
      environment: { ...previousAppState.environment, assistantHost: "mobile" },
    });

    try {
      initializeHelperApi({
        jsonrpcCall: vi.fn().mockResolvedValue({ entry: null }),
        jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
      });
      const repo = new ACPSessionRepositoryWriter();
      const session = repo.createSession("/repo", "codex-acp", "conversation:test");
      session.setGoal({
        source: "codex",
        objective: "Finish the migration",
        status: "active",
        controlMethod: CODEX_GOAL_CONTROL_METHOD,
        createdAt: 1,
      });
      render(Harness, { props: { repo: repo.publicAPI() } });

      await fireEvent.click(
        screen.getByRole("button", { name: "Goal, Active: Finish the migration" }),
      );
      const menu = screen.getByRole("menu", { name: "Goal details" });
      expect(menu.parentElement).toHaveStyle("height: var(--visual-viewport-height, 100dvh)");
      expect(menu).toHaveClass("max-h-[85%]");

      session.setGoal(null);
      await tick();
      expect(screen.queryByRole("menu", { name: "Goal details" })).not.toBeInTheDocument();

      session.setGoal({
        source: "codex",
        objective: "Ship the migration",
        status: "active",
        controlMethod: CODEX_GOAL_CONTROL_METHOD,
        createdAt: 2,
      });
      await tick();

      expect(screen.queryByRole("menu", { name: "Goal details" })).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Goal, Active: Ship the migration" }),
      ).toHaveAttribute("aria-expanded", "false");
    } finally {
      appState.set(previousAppState);
    }
  });

  it("clears a Claude goal", async () => {
    const clearGoal = vi.fn().mockResolvedValue(undefined);
    render(Harness, {
      props: {
        repo: makeRepo(
          {
            source: "claude",
            objective: "Prepare the release branch",
            status: "active",
            iterations: 3,
            lastReason: "One test still fails.",
          },
          { clearGoal },
        ),
      },
    });

    await fireEvent.click(
      screen.getByRole("button", { name: "Goal, Active: Prepare the release branch" }),
    );
    expect(screen.getByText("3 checks")).toBeInTheDocument();
    expect(screen.getByText(/One test still fails/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Clear goal" }));

    expect(clearGoal).toHaveBeenCalledOnce();
  });
});
