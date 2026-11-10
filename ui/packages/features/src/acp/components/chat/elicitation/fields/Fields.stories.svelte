<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import {
    FormModel,
    validate,
    type FieldValue,
    type FormSchema,
  } from "../../../../../elicitation";
  import { createForm } from "@tanstack/svelte-form";
  import Field from "./Field.svelte";

  const stringSchema = {
    type: "string",
    title: "Display Name",
    description: "Description text",
    minLength: 3,
    maxLength: 50,
    pattern: "^[A-Za-z]+$",
    format: "email",
    default: "user@example.com",
  };

  const numberSchema = {
    type: "number",
    title: "Number",
    description: "Number between 0 and 100",
    minimum: 0,
    maximum: 100,
    default: 50,
  };

  const secretStringSchema = {
    type: "string",
    title: "API key",
    description: "Stored for this session only",
    _meta: { codex: { isSecret: true } },
  };

  const integerSchema = {
    type: "integer",
    title: "Integer",
    description: "Whole number between 1 and 10",
    minimum: 1,
    maximum: 10,
    default: 3,
  };

  const booleanSchema = {
    type: "boolean",
    title: "Accept terms",
    description: "You must accept the terms to continue",
    default: false,
  };

  const enumBareSchema = {
    type: "string",
    title: "Color Selection",
    description: "Choose your favorite color",
    enum: ["Red", "Green", "Blue"],
    default: "Red",
  };

  const enumTitledSchema = {
    type: "string",
    title: "Color Selection",
    description: "Choose your favorite color",
    oneOf: [
      { const: "#FF0000", title: "Red" },
      { const: "#00FF00", title: "Green" },
      { const: "#0000FF", title: "Blue" },
    ],
    default: "#FF0000",
  };

  const enumWithFreeTextSchema = {
    type: "string",
    title: "Framework",
    description: "Pick one, or type your own answer",
    anyOf: [
      { const: "Svelte", title: "Svelte" },
      { const: "React", title: "React" },
      { const: "Vue", title: "Vue" },
      { type: "string" },
    ],
  };

  // Exact shape the agent's question_tool emits for "options + free-text".
  // Note: no top-level `type`, options are nested under {oneOf:[…]}.
  const agentQuestionFreeTextSchema = {
    description: "What is your favorite color?",
    anyOf: [
      {
        oneOf: [
          { const: "Red", title: "Red", description: "The color red" },
          { const: "Green", title: "Green", description: "The color green" },
          { const: "Blue", title: "Blue", description: "The color blue" },
        ],
      },
      { type: "string" },
    ],
  };

  const multiSelectBareSchema = {
    type: "array",
    title: "Color Selection",
    description: "Choose your favorite colors",
    minItems: 1,
    maxItems: 2,
    items: {
      type: "string",
      enum: ["Red", "Green", "Blue"],
    },
    default: ["Red", "Green"],
  };

  const multiSelectTitledSchema = {
    type: "array",
    title: "Color Selection",
    description: "Choose your favorite colors",
    minItems: 1,
    maxItems: 2,
    items: {
      type: "string",
      anyOf: [
        { const: "#FF0000", title: "Red" },
        { const: "#00FF00", title: "Green" },
        { const: "#0000FF", title: "Blue" },
      ],
    },
    default: ["#FF0000", "#00FF00"],
  };

  const { Story } = defineMeta({
    title: "ACP/Elicitation/Fields",
    args: {
      required: true as boolean,
      schema: {} as Record<string, unknown>,
    },
  });
</script>

{#snippet FieldPreview({
  schema,
  required,
}: {
  schema: Record<string, unknown>;
  required: boolean;
})}
  {@const model = new FormModel(
    {
      type: "object",
      properties: { value: schema },
      required: required ? ["value"] : [],
    } as unknown as FormSchema,
    { "camber/field_order": ["value"] },
  )}
  {@const entry = model.fields[0]}
  {#if entry}
    {@const form = createForm(() => ({
      defaultValues: model.defaultValues() as Record<string, FieldValue>,
      onSubmit: async () => {
        /* no-op for stories */
      },
    }))}
    <form
      class="bg-psx-background-secondary border-psx-border flex flex-col gap-2 rounded-md border p-3"
      onsubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field
        name={entry.name}
        validators={{
          onChange: ({ value }) => validate(entry.field, value, entry.required),
        }}
      >
        {#snippet children(field)}
          <Field {field} model={entry.field} required={entry.required} />
        {/snippet}
      </form.Field>

      <form.Subscribe selector={(state) => state.values}>
        {#snippet children(values)}
          <pre
            class="bg-psx-background border-psx-border text-psx-foreground-secondary overflow-x-auto rounded-md border p-2 text-xs">{JSON.stringify(
              values,
              null,
              2,
            )}</pre>
        {/snippet}
      </form.Subscribe>
    </form>
  {:else}
    <div class="text-psx-error-foreground text-xs">FormModel produced no fields</div>
  {/if}
{/snippet}

<Story name="String" args={{ schema: stringSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Number" args={{ schema: numberSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="String - secret" args={{ schema: secretStringSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Integer" args={{ schema: integerSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Boolean" args={{ schema: booleanSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum - bare values" args={{ schema: enumBareSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum - titled options" args={{ schema: enumTitledSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum - with free text" args={{ schema: enumWithFreeTextSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum - no type specified" args={{ schema: agentQuestionFreeTextSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum array - bare values" args={{ schema: multiSelectBareSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>

<Story name="Enum array - titled options" args={{ schema: multiSelectTitledSchema }}>
  {#snippet template(args)}{@render FieldPreview(args)}{/snippet}
</Story>
