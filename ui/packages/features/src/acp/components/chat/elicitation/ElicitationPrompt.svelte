<script lang="ts">
  import { Button } from "@camber/components/button";
  import { insideModalOverlay, isAppleUser } from "@camber/components";
  import Kbd from "@camber/components/kbd";
  import {
    getElicitationContext,
    FormModel,
    hasValidationFailure,
    validate,
    type FieldValue,
    type FormSchema,
  } from "../../../../elicitation";
  import { createForm } from "@tanstack/svelte-form";
  import type { SessionId } from "@agentclientprotocol/sdk";
  import Field from "./fields/Field.svelte";

  interface Props {
    /**
     * The chat this prompt renders in. Only that session's elicitations show
     * here — plus unattributed ones, which cannot be routed to one chat.
     */
    sessionId?: SessionId | null;
    agentServer?: string | null;
  }

  let { sessionId = null, agentServer = null }: Props = $props();

  const elicitation = getElicitationContext();

  const pending = $derived(elicitation.firstPendingForChat(sessionId, agentServer));

  let formElement = $state<HTMLFormElement | null>(null);

  // Desktop splits keep background tabs mounted (content-visibility: hidden in
  // PaneContainer), so every open chat's prompt listens on the window. Only
  // the visibly rendered form may claim the Escape key — otherwise Escape in
  // the focused chat would decline a hidden tab's elicitation and never reach
  // the focused chat's own handlers. checkVisibility is missing in jsdom,
  // where the form counts as visible.
  function formVisible(): boolean {
    return formElement != null && (formElement.checkVisibility?.() ?? true);
  }

  // A missing schema is a message-only confirmation (the spec defaults
  // `properties` to {}), so it still gets a form with Accept/Reject —
  // otherwise the elicitation would render nothing and be unanswerable.
  // Url-mode elicitations are excluded: without an open-URL affordance an
  // Accept/Reject card would let Accept falsely complete an out-of-band flow
  // (e.g. OAuth) the user never saw.
  const model = $derived<FormModel | undefined>(
    pending && pending.mode !== "url"
      ? new FormModel(
          (pending.requestedSchema ?? { type: "object", properties: {} }) as FormSchema,
          pending._meta,
        )
      : undefined,
  );
  const elicitationId = $derived(pending?.elicitationId);
  const message = $derived(pending?.message ?? "");
</script>

<svelte:window
  onkeydowncapture={(e) => {
    if (!pending || !formVisible()) return;
    // Keystrokes inside a modal overlay (e.g. the conversation search) belong
    // to that overlay: Escape there closes it, it must not decline the form.
    if (insideModalOverlay(e.target)) return;
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (elicitationId) elicitation.decline(elicitationId);
    }
  }}
/>

{#if pending && model && elicitationId}
  {#key elicitationId}
    {@render FormBody(elicitationId, model)}
  {/key}
{/if}

{#snippet FormBody(id: string, model: FormModel)}
  {@const form = createForm(() => ({
    // Saved answers win over the schema defaults, but only per field: a field
    // the user never touched still picks up its default. The draft outlives
    // this component, which an ordinary conversation switch remounts.
    defaultValues: { ...model.defaultValues(), ...elicitation.draftFor(id) } as Record<
      string,
      FieldValue
    >,
    onSubmit: async ({ value }) => {
      elicitation.accept(id, value as Record<string, unknown>);
    },
  }))}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!--
    Cap the form to the chat pane's height, not the viewport, so its Submit row
    is never clipped when a terminal/split shrinks the pane (PE-2475). Two
    limits do that:

    shrink-[100]: this form shares the composer column with the prompt itself,
    and that column is capped to the conversation area. A tall form must be the
    item that gives up height there — otherwise the column overflows and pushes
    the prompt below the window edge. The weight (not a plain shrink) keeps the
    banners sharing the column from absorbing any of it.

    max-height: a standalone guard for surfaces that render this form outside
    that column. ChatPane publishes the conversation-area height as
    --acp-conversation-area-height; the 100dvh fallback covers isolated renders
    that don't set the var.

    Either way the fields region below scrolls while the message and Submit rows
    stay pinned.
  -->
  <form
    bind:this={formElement}
    class="border-psx-border bg-psx-editor-background text-psx-foreground-primary shadow-low dark:shadow-low-dark flex min-h-0 shrink-[100] flex-col gap-2 rounded-md border p-2"
    style="max-height: var(--acp-conversation-area-height, 100dvh)"
    onsubmit={(e) => {
      e.preventDefault();
      void form.handleSubmit();
    }}
    onkeydown={(e) => {
      if (e.code === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void form.handleSubmit();
      }
    }}
  >
    {#if message}
      {@const hideMessage =
        model.fields.length === 1 && message === model.fields[0].field.description}
      {#if !hideMessage}
        <div class="text-psx-foreground-secondary shrink-0 text-sm">{message}</div>
      {/if}
    {/if}

    <!-- One rule between questions. divide-y hangs the rule off the BOTTOM of
         each question but the flex gap falls below it, so the matching padding
         goes on the same elements the rule does — otherwise the line hugs the
         question above it instead of sitting mid-gutter. -->
    <div
      class="divide-psx-border flex min-h-0 flex-1 flex-col gap-3 divide-y overflow-y-auto overscroll-contain [&>*:not(:last-child)]:pb-3"
    >
      {#each model.fieldGroups as group (group[0].name)}
        <!-- A group is one question: its options plus the free-text "Other"
             that answers the same question. They stay on the same side of the
             rule. -->
        <div class="flex flex-col gap-3">
          {#each group as entry (entry.name)}
            <form.Field
              name={entry.name}
              listeners={{
                // Save on every change rather than on submit: the point is to
                // survive a conversation switch, which needs no submit to happen.
                onChange: ({ value }) =>
                  elicitation.rememberAnswer(id, entry.name, value as FieldValue),
              }}
              validators={{
                // onChange only: a failed submit runs every configured validator
                // and records its error per cause; a later handleChange re-runs
                // just the change validator, so an onBlur duplicate would keep its
                // stale error (and the disabled submit button) until the next blur.
                onChange: ({ value }) => validate(entry.field, value, entry.required),
              }}
            >
              {#snippet children(field)}
                <Field {field} model={entry.field} required={entry.required} />
              {/snippet}
            </form.Field>
          {/each}
        </div>
      {/each}
    </div>

    <form.Subscribe
      selector={(state) => ({
        canSubmit: state.canSubmit,
        isSubmitting: state.isSubmitting,
        values: state.values as Record<string, unknown>,
      })}
    >
      {#snippet children(state)}
        <div class="flex shrink-0 flex-wrap gap-1.5 pt-2">
          <Button
            type="submit"
            prominence="increased"
            disabled={!state.canSubmit ||
              state.isSubmitting ||
              hasValidationFailure(model.fields, state.values)}
            class="justify-between gap-3"
          >
            <span>{model.fields.length > 0 ? "Submit answers" : "Accept"}</span>
            <Kbd label={isAppleUser() ? "⌘↵" : "Ctrl+↵"} />
          </Button>
          <Button
            type="button"
            onclick={() => elicitation.decline(id)}
            disabled={state.isSubmitting}
            class="justify-between gap-3"
          >
            <span>Reject</span>
            <Kbd label="esc" />
          </Button>
        </div>
      {/snippet}
    </form.Subscribe>
  </form>
{/snippet}
