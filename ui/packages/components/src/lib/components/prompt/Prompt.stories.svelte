<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { Root } from "./index.js";
  import { expect, fn, waitFor } from "storybook/test";
  import * as Prompt from "./index.js";
  import { PointerEventsCheckLevel } from "@testing-library/user-event";

  const { Story } = defineMeta({
    component: Root,
    args: {
      onSubmit: fn(),
    },
  });

  const longLink =
    "https://example.com/search?query=long-link-wrapping-example&category=documentation&sort=relevance&offset=0&limit=100&format=json&pretty=true&description=this-is-a-deliberately-long-synthetic-url-used-to-check-that-the-prompt-editor-wraps-links-without-horizontal-overflow&fixture=prompt-editor";
</script>

{#snippet form()}
  <Prompt.Form.Root>
    <Prompt.Form.Field.Root>
      <Prompt.Form.Field.Editor.Root>
        <Prompt.Form.Field.Editor.Suggestion />
        <Prompt.Form.Field.Editor.Placeholder>
          Ask camber something...
        </Prompt.Form.Field.Editor.Placeholder>
      </Prompt.Form.Field.Editor.Root>
    </Prompt.Form.Field.Root>

    <Prompt.Form.Footer>
      <Prompt.Form.Submit />
    </Prompt.Form.Footer>
  </Prompt.Form.Root>
{/snippet}

<Story
  name="Text Entry"
  play={async ({ canvas, userEvent, step, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    const submitButton = canvas.getByRole("button", { name: "Submit" });
    const typedText = "hello world";

    await step("updates the editor when text is entered", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard(typedText);

      await expect(promptInput).toHaveTextContent(typedText);
      expect(submitButton).toBeEnabled();
    });

    await step("submits editor content and clears the input", async () => {
      await userEvent.click(submitButton);

      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith(typedText));
      await waitFor(() => expect(promptInput).toHaveTextContent(""));
      await waitFor(() => expect(submitButton).toBeDisabled());
    });
  }}
>
  {@render form()}
</Story>

<Story
  name="Suggested Prompt — Enter"
  args={{
    suggestion: "Run the focused tests",
    onSuggestionAccepted: fn(),
    onSubmit: fn(),
  }}
  play={async ({ canvas, userEvent, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    await expect(canvas.getByTestId("prompt-suggestion")).toHaveTextContent(
      "Run the focused tests",
    );
    await expect(canvas.getByTestId("prompt-suggestion")).toHaveTextContent("to send");
    await expect(canvas.getByTestId("prompt-suggestion")).toHaveAccessibleName(
      "Suggested prompt: Run the focused tests. Enter sends; Tab or Right Arrow edits",
    );
    expect(canvas.queryByText("Ask camber something...")).not.toBeInTheDocument();

    await userEvent.click(promptInput);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("Run the focused tests"));
    expect(args.onSuggestionAccepted).toHaveBeenCalledWith("Run the focused tests");
    await expect(promptInput).toHaveTextContent("");
  }}
>
  {@render form()}
</Story>

<Story
  name="Suggested Prompt — Tab"
  args={{
    suggestion: "Run the focused tests",
    onSuggestionAccepted: fn(),
  }}
  play={async ({ canvas, userEvent, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    await userEvent.click(promptInput);
    await userEvent.keyboard("{Tab}");
    await expect(promptInput).toHaveTextContent("Run the focused tests");
    expect(args.onSuggestionAccepted).toHaveBeenCalledWith("Run the focused tests");
    expect(canvas.queryByTestId("prompt-suggestion")).not.toBeInTheDocument();
  }}
>
  {@render form()}
</Story>

<Story
  name="Suggested Prompt — Right Arrow"
  args={{
    suggestion: "Inspect the latest failure",
    onSuggestionAccepted: fn(),
  }}
  play={async ({ canvas, userEvent, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    await userEvent.click(promptInput);
    await userEvent.keyboard("{ArrowRight}");

    await expect(promptInput).toHaveTextContent("Inspect the latest failure");
    expect(args.onSuggestionAccepted).toHaveBeenCalledWith("Inspect the latest failure");
  }}
>
  {@render form()}
</Story>

<Story
  name="Suggested Prompt — Click Focuses Without Accepting"
  args={{
    suggestion: "Open the changed files",
    onSuggestionAccepted: fn(),
  }}
  play={async ({ canvas, userEvent, args }) => {
    const promptInput = canvas.getByTestId("prompt-input");
    const suggestion = canvas.getByTestId("prompt-suggestion");
    const rect = suggestion.getBoundingClientRect();
    const clickTarget = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);

    expect(clickTarget).not.toBeNull();
    expect(promptInput.contains(clickTarget)).toBe(true);
    await userEvent.click(clickTarget as Element);

    await expect(promptInput).toHaveFocus();
    await expect(promptInput).toHaveTextContent("");
    expect(args.onSuggestionAccepted).not.toHaveBeenCalled();
    await expect(suggestion).toHaveTextContent("Open the changed files");
  }}
>
  {@render form()}
</Story>

<Story
  name="Multi-line Paragraph Stability"
  play={async ({ canvas, userEvent }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await userEvent.click(promptInput);
    await userEvent.keyboard("hi{Shift>}{Enter}{/Shift}hi{Shift>}{Enter}{/Shift}");

    const paragraphs = promptInput.querySelectorAll("p");
    expect(paragraphs).toHaveLength(3);

    const trailingParagraph = paragraphs[2] as HTMLElement;
    const emptyEditorHeight = promptInput.getBoundingClientRect().height;

    await userEvent.keyboard("h");

    expect(trailingParagraph).toHaveTextContent("h");
    expect(promptInput.getBoundingClientRect().height).toBe(emptyEditorHeight);
  }}
>
  {@render form()}
</Story>

<Story
  name="Long Link Wrapping"
  args={{ value: `check this failing service ${longLink} and tell me why` }}
  play={async ({ canvas }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    await waitFor(() => expect(promptInput).toHaveTextContent("check this failing service"));

    // A long unbreakable link must wrap inside the field, not widen the
    // editor past it: an oversized editor lets caret-reveal scroll the
    // field sideways, visually eating the composer's padding (PE-2433).
    const field = promptInput.closest("[data-prompt-field]") as HTMLElement;
    expect(promptInput.getBoundingClientRect().height).toBeGreaterThan(30);
    expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth);
    expect(field.scrollLeft).toBe(0);
  }}
>
  {@render form()}
</Story>

<Story
  name="Command Enter Submission"
  args={{ onSubmitNow: fn() }}
  play={async ({ canvas, userEvent, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await userEvent.click(promptInput);
    await userEvent.keyboard("send now{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(args.onSubmitNow).toHaveBeenCalledWith("send now"));
    expect(args.onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(promptInput).toHaveTextContent(""));
  }}
>
  {@render form()}
</Story>

<Story
  name="IME Composition"
  play={async ({ canvas, userEvent, step, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    const submitButton = canvas.getByRole("button", { name: "Submit" });

    await userEvent.click(promptInput);
    await userEvent.keyboard("hello");

    await step("Enter is swallowed while a composition is in progress", async () => {
      promptInput.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      // Synthetic keydown, not userEvent: a real IME consumes the Enter key
      // itself, whereas a real key press during a synthetic composition would
      // let the browser's default action insert a line break.
      promptInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      expect(args.onSubmit).not.toHaveBeenCalled();
    });

    await step("the send button stays enabled during a composition", async () => {
      // Clicking send inherently commits or cancels a pending composition, so
      // a (possibly stale) composing flag must not disable the click path.
      // Regression for PE-2456: the button got stuck disabled when macOS
      // predictive text started a composition that ended without an editor
      // transaction.
      expect(submitButton).toBeEnabled();
    });

    await step("Enter submits after the composition ends without a transaction", async () => {
      promptInput.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("hello"));
      await waitFor(() => expect(promptInput).toHaveTextContent(""));
    });
  }}
>
  {@render form()}
</Story>

{#snippet actionsMenu()}
  <Prompt.Menu.Root
    rules={[
      {
        trigger: "/",
        triggerRegExp: /(?<=^|\s)\/(?!\s)/g,
        queryRegExp: /^\S*(?:\s.*)?$/,
      },
    ]}
    filterOptions={{
      strictTitleMatching: true,
    }}
  >
    <Prompt.Menu.Popup.Root>
      <Prompt.Menu.Popup.List>
        <Prompt.Menu.Popup.Empty title="No matching commands" icon="slash" />

        <Prompt.Menu.Popup.Section title="Actions">
          <Prompt.Menu.Popup.Item title="model" class="menu-item-model">
            <Prompt.Actions.Push menu="models" completion="model" />
          </Prompt.Menu.Popup.Item>
          <Prompt.Menu.Popup.Item title="action" class="menu-item-action">
            <Prompt.Actions.Action
              title="A context-specific action that can be performed by the user"
            />
          </Prompt.Menu.Popup.Item>
        </Prompt.Menu.Popup.Section>

        <Prompt.Menu.Popup.Separator />

        <Prompt.Menu.Popup.Section title="Insert">
          <Prompt.Menu.Popup.Item title="text" class="menu-item-text">
            <Prompt.Actions.Insert
              type="text"
              title="Action that inserts text into the content"
              content="hello"
            />
          </Prompt.Menu.Popup.Item>
          <Prompt.Menu.Popup.Item title="chip" class="menu-item-chip">
            <Prompt.Actions.Insert
              type="chip"
              title="Action that inserts a chip into the content"
              content={{
                label: "hello",
              }}
            />
          </Prompt.Menu.Popup.Item>
        </Prompt.Menu.Popup.Section>
      </Prompt.Menu.Popup.List>
    </Prompt.Menu.Popup.Root>
  </Prompt.Menu.Root>

  <Prompt.Menu.Root value="models">
    <Prompt.Menu.Popup.Root>
      <Prompt.Menu.Popup.List>
        <Prompt.Menu.Popup.Section title="Models">
          <Prompt.Menu.Popup.Item title="Riemann Turbo" class="menu-item-riemann">
            <Prompt.Actions.Action keepOpen />
          </Prompt.Menu.Popup.Item>
          <Prompt.Menu.Popup.Item title="Laguna" class="menu-item-laguna">
            <Prompt.Actions.Action keepOpen />
          </Prompt.Menu.Popup.Item>
        </Prompt.Menu.Popup.Section>
      </Prompt.Menu.Popup.List>
    </Prompt.Menu.Popup.Root>
  </Prompt.Menu.Root>
{/snippet}

<Story name="Actions">
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="Command Match Ends After Whitespace"
  play={async ({ canvas, userEvent }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await userEvent.click(promptInput);
    await userEvent.keyboard("look in my /tmp directory");

    await expect(promptInput).toHaveTextContent("look in my /tmp directory");
    await waitFor(() => expect(canvas.queryByRole("listbox")).not.toBeInTheDocument());
    expect(promptInput.querySelector("span")).toBeNull();
  }}
>
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="Insert Text Action"
  play={async ({ canvas, userEvent, step }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await step("inserts text at cursor position, replacing the trigger", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("/text");
      await waitFor(() =>
        expect(canvas.getByRole("listbox").querySelector(".menu-item-text")).toBeVisible(),
      );
      await userEvent.keyboard("{Enter}");

      await waitFor(() => expect(promptInput).toHaveTextContent("hello"));
    });
  }}
>
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="Insert Chip Action"
  play={async ({ canvas, userEvent, step }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await step("inserts a chip element, replacing the trigger", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("/chip");
      await waitFor(() =>
        expect(canvas.getByRole("listbox").querySelector(".menu-item-chip")).toBeVisible(),
      );
      await userEvent.keyboard("{Enter}");

      const chipNode = await waitFor(() =>
        canvas.getByRole("application").querySelector(".chip-node"),
      );
      expect(chipNode).toBeInTheDocument();
      expect(chipNode).toHaveAttribute("data-label", "hello");
    });
  }}
>
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="Menu Filtering"
  play={async ({ canvas, userEvent, step }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await step("filters menu items based on typed query", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("/ch");
      await waitFor(() =>
        expect(canvas.getByRole("listbox").querySelector(".menu-item-chip")).toBeVisible(),
      );

      expect(
        canvas.getByRole("listbox").querySelector(".menu-item-action"),
      ).not.toBeInTheDocument();
      expect(canvas.getByRole("listbox").querySelector(".menu-item-text")).not.toBeInTheDocument();
    });

    await step("shows empty state when no items match", async () => {
      await userEvent.keyboard("xyz");
      await waitFor(() => expect(canvas.getByText("No matching commands")).toBeVisible());
    });
  }}
>
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="Push Menu Completion"
  play={async ({ canvas, userEvent, step }) => {
    const promptInput = await canvas.findByTestId("prompt-input");

    await step("completes the canonical command before opening its submenu", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("/mo");
      await waitFor(() =>
        expect(canvas.getByRole("listbox").querySelector(".menu-item-model")).toBeVisible(),
      );
      await userEvent.keyboard("{Enter}");

      await waitFor(() => expect(promptInput.textContent).toBe("/model "));
    });

    await step("filters the submenu after the completed command", async () => {
      await userEvent.keyboard("rie");

      await waitFor(() => expect(promptInput.textContent).toBe("/model rie"));
      expect(canvas.getByRole("listbox").querySelector(".menu-item-riemann")).toBeVisible();
      expect(
        canvas.getByRole("listbox").querySelector(".menu-item-laguna"),
      ).not.toBeInTheDocument();
    });
  }}
>
  {@render form()}
  {@render actionsMenu()}
</Story>

<Story
  name="submitDisabled - explicit true"
  args={{ submitDisabled: true }}
  play={async ({ canvas, userEvent, step, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    const submitButton = canvas.getByRole("button", { name: "Submit" });

    await step("submit button is disabled even with content", async () => {
      expect(submitButton).toBeDisabled();

      await userEvent.click(promptInput);
      await userEvent.keyboard("some text");

      await expect(promptInput).toHaveTextContent("some text");
      expect(submitButton).toBeDisabled();
    });

    await step("clicking submit does not submit", async () => {
      await userEvent
        .setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
        .click(submitButton);
      expect(args.onSubmit).not.toHaveBeenCalled();
    });

    await step("pressing Enter does not submit", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("{Enter}");
      expect(args.onSubmit).not.toHaveBeenCalled();
    });
  }}
>
  {@render form()}
</Story>

<Story
  name="submitDisabled - explicit false"
  args={{ submitDisabled: false }}
  play={async ({ canvas, userEvent, step, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    const submitButton = canvas.getByRole("button", { name: "Submit" });

    await step("cannot submit when empty", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(args.onSubmit).not.toHaveBeenCalled());
    });

    await step("typing and pressing Enter submits", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("some text{Enter}");
      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("some text"));
    });

    await step("clicking submit also works", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("click test");
      await userEvent.click(submitButton);
      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("click test"));
    });
  }}
>
  {@render form()}
</Story>

<Story
  name="submitDisabled Undefined"
  play={async ({ canvas, userEvent, step, args }) => {
    const promptInput = await canvas.findByTestId("prompt-input");
    const submitButton = canvas.getByRole("button", { name: "Submit" });

    await step("submit button follows normal canSubmit logic", async () => {
      // Initially disabled (no content)
      expect(submitButton).toBeDisabled();

      await userEvent.click(promptInput);
      await userEvent.keyboard("some text");

      // Enabled after content is entered
      await expect(promptInput).toHaveTextContent("some text");
      expect(submitButton).toBeEnabled();
    });

    await step("pressing Enter submits the text", async () => {
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("some text"));
    });

    await step("typing more and clicking submit also works", async () => {
      await userEvent.click(promptInput);
      await userEvent.keyboard("more text");
      await userEvent.click(submitButton);
      await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith("more text"));
    });
  }}
>
  {@render form()}
</Story>
