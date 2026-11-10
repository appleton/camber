import type { ACPElicitationParams } from "@camber/helperapi/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import type { ElicitationRepository } from "../../../../elicitation";
import Harness from "./ElicitationPrompt.test.svelte";

// The agent question tool's "options + free-text" shape: preset options
// nested under {oneOf:[…]} plus a {type:"string"} free-text branch.
const questionParams = {
  elicitationId: "elicitation-1",
  message: "What is your favorite color?",
  requestedSchema: {
    type: "object",
    properties: {
      answer: {
        description: "What is your favorite color?",
        anyOf: [
          {
            oneOf: [
              { const: "Red", title: "Red" },
              { const: "Green", title: "Green" },
            ],
          },
          { type: "string" },
        ],
      },
    },
    required: ["answer"],
  },
} as unknown as ACPElicitationParams;

describe("ElicitationPrompt", () => {
  async function setup() {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register(questionParams);
    await tick();
    const textarea = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      "Or type your own answer...",
    );
    const submit = await screen.findByRole("button", { name: /Submit answers/ });
    return { repo, textarea, submit };
  }

  it("enables submit while typing a free-text answer, without blur", async () => {
    const { textarea, submit } = await setup();

    await fireEvent.input(textarea, { target: { value: "Purple" } });

    expect(submit).not.toBeDisabled();
  });

  it("disables submit while clearing the free-text answer, without blur", async () => {
    const { textarea, submit } = await setup();

    await fireEvent.input(textarea, { target: { value: "Purple" } });
    expect(submit).not.toBeDisabled();

    await fireEvent.input(textarea, { target: { value: "" } });

    expect(submit).toBeDisabled();
  });
});

describe("ElicitationPrompt constrained layout (PE-2475)", () => {
  // PE-2475: the fields box sized itself to the viewport
  // (max-h-[calc(100dvh-16rem)]). The form lives in ChatPane's composer, which
  // is shrink-0 / auto-height, so a viewport-based cap let the form outgrow the
  // pane and the Submit row was clipped when a terminal/split shrank the pane.
  // The fields scroll independently while the message and Submit rows remain
  // outside that scrolling region.
  it("keeps the fields scrollable and the submit row pinned", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({ ...questionParams, elicitationId: "elicitation-3" });
    await tick();
    const submit = await screen.findByRole("button", { name: /Submit answers/ });

    const form = submit.closest("form");
    expect(form).not.toBeNull();
    expect(form?.className).toContain("min-h-0");

    // The fields region — not the whole form — is what scrolls.
    const scroller = form?.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("flex-1");
    expect(scroller?.className).toContain("min-h-0");
    // The viewport-only cap that caused PE-2475 must be gone from the fields.
    expect(scroller?.className).not.toContain("100dvh");

    // The Submit/Reject row is pinned (never compressed by the scroll region).
    const submitRow = submit.parentElement;
    expect(submitRow?.className).toContain("shrink-0");
  });
});

describe("ElicitationPrompt after a failed submit attempt", () => {
  // PE-2419: a failed submit runs every configured validator and records its
  // error per cause. Typing re-runs only the change validator, so any other
  // cause's stale error must not keep the submit button disabled until blur.
  it("re-enables submit while typing after submitting empty", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({ ...questionParams, elicitationId: "elicitation-2" });
    await tick();
    const textarea = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      "Or type your own answer...",
    );
    const submit = await screen.findByRole("button", { name: /Submit answers/ });

    // Submitting an unanswered form is already blocked; click anyway, since
    // PE-2419 was about the state a submit attempt leaves behind.
    expect(submit).toBeDisabled();
    await fireEvent.click(submit);
    expect(submit).toBeDisabled();

    // Typing must clear the error and re-enable submit without a blur.
    await fireEvent.input(textarea, { target: { value: "Purple" } });

    expect(submit).not.toBeDisabled();
  });

  // The form library leaves `canSubmit` true until a field has been edited, so
  // an untouched form used to offer a button whose only outcome was failure.
  it("starts with submit disabled while a required answer is missing", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({ ...questionParams, elicitationId: "elicitation-untouched" });
    await tick();

    const submit = await screen.findByRole("button", { name: /Submit answers/ });
    expect(submit).toBeDisabled();

    // …and enables as soon as the required field has an answer.
    const textarea = await screen.findByPlaceholderText<HTMLTextAreaElement>(
      "Or type your own answer...",
    );
    await fireEvent.input(textarea, { target: { value: "Purple" } });

    expect(submit).not.toBeDisabled();
  });

  // A confirmation has nothing to answer, so its button must not be caught by
  // the same rule.
  it("leaves accept enabled for a message-only elicitation", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "confirm-enabled",
      message: "Proceed?",
      mode: "form",
    } as unknown as ACPElicitationParams);
    await tick();

    expect(await screen.findByRole("button", { name: /Accept/ })).not.toBeDisabled();
  });

  // The `*` on the label already says a field is needed; an untouched form
  // must not answer a submit attempt with a column of red errors.
  it("does not render a message for the unanswered required field", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({ ...questionParams, elicitationId: "elicitation-required" });
    await tick();
    const submit = await screen.findByRole("button", { name: /Submit answers/ });

    await fireEvent.click(submit);

    expect(submit).toBeDisabled();
    expect(screen.queryByText("Required")).toBeNull();
  });

  // Only the required-but-empty case is silent: a wrong answer still needs
  // saying, or the button disables with no explanation.
  it("still renders a validation failure the user's answer caused", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "elicitation-too-short",
      message: "Name?",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string", title: "Name", minLength: 5 } },
        required: ["name"],
      },
    } as unknown as ACPElicitationParams);
    await tick();
    const input = await screen.findByLabelText<HTMLInputElement>(/Name/);

    await fireEvent.input(input, { target: { value: "abc" } });

    await screen.findByText("Must be at least 5 characters");
  });
});

describe("ElicitationPrompt standard-elicitation shapes", () => {
  // Standard (unstable) ACP elicitation defaults `properties` to {} and may
  // omit the schema entirely: a message-only confirmation. It must still
  // render an answerable card instead of nothing.
  it("renders a message-only elicitation and accepts with empty content", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    const answered = repo.register({
      elicitationId: "confirm-1",
      message: "Proceed with the migration?",
      mode: "form",
    } as unknown as ACPElicitationParams);
    await tick();

    await screen.findByText("Proceed with the migration?");
    const accept = await screen.findByRole("button", { name: /Accept/ });
    await fireEvent.click(accept);

    await expect(answered).resolves.toEqual({ action: "accept", content: {} });
  });

  // Url-mode elicitations have no open-URL affordance yet; rendering them as
  // an Accept/Reject card would let Accept falsely complete an out-of-band
  // flow (e.g. OAuth) the user never saw. They must render nothing.
  it("does not render url-mode elicitations as answerable forms", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "url-1",
      message: "Sign in to continue",
      mode: "url",
      url: "https://example.com/auth",
    } as unknown as ACPElicitationParams);
    await tick();

    expect(screen.queryByText("Sign in to continue")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Codex marks secret request_user_input questions with _meta.codex.isSecret;
  // they must be masked and never widen into a textarea.
  it("masks secret codex fields as password inputs", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "secret-1",
      message: "Provide your API key",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "API key",
            maxLength: 500,
            _meta: { codex: { isSecret: true } },
          },
        },
        required: ["token"],
      },
    } as unknown as ACPElicitationParams);
    await tick();

    const input = await screen.findByLabelText<HTMLInputElement>(/API key/);
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("password");
  });

  it("validates an integer field as a whole number", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "int-1",
      message: "How many?",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          count: { type: "integer", title: "Count", minimum: 1 },
        },
        required: ["count"],
      },
    } as unknown as ACPElicitationParams);
    await tick();

    const input = await screen.findByLabelText<HTMLInputElement>(/Count/);
    expect(input.type).toBe("number");
    expect(input.step).toBe("1");
    const submit = await screen.findByRole("button", { name: /Submit answers/ });

    await fireEvent.input(input, { target: { value: "2.5" } });
    await screen.findByText("Must be a whole number");
    expect(submit).toBeDisabled();

    await fireEvent.input(input, { target: { value: "3" } });
    expect(screen.queryByText("Must be a whole number")).toBeNull();
    expect(submit).not.toBeDisabled();
  });
});

describe("ElicitationPrompt across a conversation switch", () => {
  // Switching conversations remounts this component, and the TanStack form's
  // state goes with it — a half-filled form used to come back reseeded from
  // the schema defaults, losing every answer the user had given.
  const findFreeText = () =>
    screen.findByPlaceholderText<HTMLTextAreaElement>("Or type your own answer...");

  // Register during init, as in the app: the elicitation is already pending on
  // the shared repository by the time a chat pane mounts its prompt.
  function renderPending(params: ACPElicitationParams) {
    let repo!: ElicitationRepository;
    const view = render(Harness, {
      onReady: (r: ElicitationRepository) => {
        repo = r;
        void r.register(params);
      },
    });
    // The repository is app-level and outlives the pane, so the remount has to
    // be of the prompt alone — re-rendering the harness would hand the second
    // mount a repository that never saw the first one's answers.
    const remount = async () => {
      await view.rerender({ mounted: false });
      await view.rerender({ mounted: true });
      await tick();
    };
    return { repo, remount };
  }

  it("restores answers entered before the remount", async () => {
    const { remount } = renderPending({
      ...questionParams,
      elicitationId: "elicitation-draft-1",
    });
    await tick();
    await fireEvent.input(await findFreeText(), { target: { value: "Purple" } });

    await remount();

    expect((await findFreeText()).value).toBe("Purple");
  });

  it("starts clean once the elicitation has been answered", async () => {
    const { repo, remount } = renderPending({
      ...questionParams,
      elicitationId: "elicitation-draft-2",
    });
    await tick();
    await fireEvent.input(await findFreeText(), { target: { value: "Purple" } });

    // Answering drops the draft, so a re-delivered request is not pre-filled
    // with answers meant for the previous one.
    repo.decline("elicitation-draft-2");
    await tick();
    void repo.register({ ...questionParams, elicitationId: "elicitation-draft-2" });
    await remount();

    expect((await findFreeText()).value).toBe("");
  });
});

describe("ElicitationPrompt initial validity", () => {
  // A required integer defaults to 0 (there is no "empty" number), so a
  // `minimum` above zero starts the form invalid without ever being
  // "Required". The submit gate has to look at the whole validation result,
  // not just the missing-answer case, or it offers a button that can only
  // fail.
  it("starts with submit disabled when a default value fails its schema", async () => {
    let repo: ElicitationRepository | undefined;
    render(Harness, { onReady: (r: ElicitationRepository) => (repo = r) });
    if (!repo) throw new Error("harness did not provide the repository");
    void repo.register({
      elicitationId: "min-1",
      message: "How many?",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { count: { type: "integer", title: "Count", minimum: 1 } },
        required: ["count"],
      },
    } as unknown as ACPElicitationParams);
    await tick();

    const submit = await screen.findByRole("button", { name: /Submit answers/ });
    expect(submit).toBeDisabled();

    // The reason is visible: a disabled button with no explanation is a dead
    // end, and unlike "Required" this is not something the asterisk covers.
    await screen.findByText("Must be ≥ 1");

    const input = await screen.findByLabelText<HTMLInputElement>(/Count/);
    await fireEvent.input(input, { target: { value: "3" } });

    expect(submit).not.toBeDisabled();
  });
});
