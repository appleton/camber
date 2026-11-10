<script lang="ts">
  import { Checkbox } from "@camber/components/checkbox";
  import type { AnyFieldApi } from "@tanstack/svelte-form";
  import type { BooleanField } from "../../../../../elicitation";
  import FieldErrors from "./FieldErrors.svelte";

  interface Props {
    field: AnyFieldApi;
    model: BooleanField;
    required: boolean;
  }

  const { field, model, required }: Props = $props();
</script>

<div class="flex flex-col gap-1">
  <label for={field.name} class="text-psx-foreground-primary flex items-start gap-2 text-sm">
    <Checkbox
      id={field.name}
      checked={field.state.value === true}
      onCheckedChange={(v) => {
        field.handleChange(v === true);
        field.handleBlur();
      }}
    />
    <span class="flex flex-col gap-0.5">
      <span class="font-medium">
        {model.title ?? field.name}
        {#if required}<span class="text-psx-error-foreground">*</span>{/if}
      </span>
      {#if model.description}
        <span class="text-psx-foreground-secondary text-xs">{model.description}</span>
      {/if}
    </span>
  </label>
  <FieldErrors {field} {model} {required} />
</div>
