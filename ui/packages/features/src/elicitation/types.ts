// Types mirror the ACP elicitation restricted JSON Schema directly, so a
// `JSON.parse(wire)` value can be type-asserted onto `FormSchema` after a
// runtime guard — no translation layer, no derived taxonomy.
// Reference: https://agentclientprotocol.com/rfds/elicitation#restricted-json-schema

import type { _ACPElicitationParamsMeta } from "@camber/helperapi/schemas";
import { isArray, isPlainObject, isString, uniq } from "lodash";

const META_KEY_FIELD_ORDER = "camber/field_order";

export interface EnumOption {
  readonly const: string;
  readonly title?: string;
  readonly description?: string;
}

export type FieldValue = string | number | boolean | readonly string[] | undefined;

interface BaseField {
  readonly title?: string;
  readonly description?: string;
  readonly _meta?: Record<string, unknown>;
}

export interface StringField extends BaseField {
  readonly type: "string";
  readonly default?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
}

export interface EnumField extends BaseField {
  readonly default?: string;
  readonly enum?: readonly string[];
  readonly oneOf?: readonly EnumOption[];
  readonly anyOf?: readonly StringAnyOfBranch[];
}

export type StringAnyOfBranch =
  | EnumOption
  | { readonly oneOf: readonly EnumOption[] }
  | { readonly type: "string" };

export interface NumberField extends BaseField {
  readonly type: "number" | "integer";
  readonly default?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanField extends BaseField {
  readonly type: "boolean";
  readonly default?: boolean;
}

export interface ArrayField extends BaseField {
  readonly type: "array";
  readonly default?: readonly string[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items: {
    readonly type: "string";
    readonly enum?: readonly string[];
    readonly anyOf?: readonly EnumOption[];
  };
}

export type FieldModel = StringField | EnumField | NumberField | BooleanField | ArrayField;

export interface FormSchema extends BaseField {
  readonly type: "object";
  readonly properties: Record<string, FieldModel>;
  readonly required?: readonly string[];
}

export interface FormField {
  readonly name: string;
  readonly field: FieldModel;
  readonly required: boolean;
}

export class FormModel {
  readonly fields: readonly FormField[];

  /**
   * `fields`, but with each question's free-text "Other" companion folded in
   * beside it. One group is one question as the user reads it, so the form can
   * separate questions without cutting a question away from its own escape
   * hatch. Fields with no companion are groups of one.
   */
  readonly fieldGroups: readonly (readonly FormField[])[];

  constructor(
    readonly schema: FormSchema,
    meta?: _ACPElicitationParamsMeta,
  ) {
    const requiredSet = new Set(schema.required ?? []);
    // The elicitation spec defaults `properties` to {} — a schema without it
    // is a message-only confirmation, not an error.
    const properties = schema.properties ?? {};
    this.fields = orderKeys(meta, Object.keys(properties)).map((name) => ({
      name,
      field: properties[name],
      required: requiredSet.has(name),
    }));

    const groups: FormField[][] = [];
    for (const entry of this.fields) {
      const open = groups.at(-1);
      if (open && continuesField(entry, open[open.length - 1])) open.push(entry);
      else groups.push([entry]);
    }
    this.fieldGroups = groups;
  }

  defaultValues(): Record<string, FieldValue> {
    return Object.fromEntries(this.fields.map((entry) => [entry.name, defaultValue(entry.field)]));
  }
}

export function isEnumField(field: FieldModel): field is EnumField {
  return "enum" in field || "oneOf" in field || "anyOf" in field;
}

export function isNumberField(field: FieldModel): field is NumberField {
  return "type" in field && (field.type === "number" || field.type === "integer");
}

/**
 * Whether a field's value must be masked while typing. Codex marks secret
 * `request_user_input` questions with `_meta.codex.isSecret`; there is no
 * structural slot for this in the restricted schema.
 */
export function isSecretField(field: FieldModel): boolean {
  const codex = (field._meta as Record<string, unknown> | undefined)?.["codex"];
  return isPlainObject(codex) && (codex as Record<string, unknown>)["isSecret"] === true;
}

/**
 * Whether `entry` is the free-text "Other" companion of the field before it
 * rather than a question of its own. Agents split "pick an option or write
 * your own" across two schema properties, and neither shape is guessable:
 *
 * - codex-acp marks the companion with `_meta.codex.isOtherAnswer` and names
 *   the question it belongs to in `questionId`.
 * - claude-agent-acp sends no metadata and relies on its key convention,
 *   `question_<n>` paired with `question_<n>_custom`.
 *
 * Both are checked against the preceding field, so a companion that names a
 * different question — or arrives without one — stays its own question rather
 * than being silently absorbed.
 */
function continuesField(entry: FormField, previous: FormField): boolean {
  const codex = (entry.field._meta as Record<string, unknown> | undefined)?.["codex"];
  if (isPlainObject(codex) && (codex as Record<string, unknown>)["isOtherAnswer"] === true) {
    return (codex as Record<string, unknown>)["questionId"] === previous.name;
  }
  return entry.name === `${previous.name}_custom`;
}

function defaultValue(field: FieldModel): FieldValue {
  if (isEnumField(field)) return field.default ?? "";
  switch (field.type) {
    case "number":
    case "integer":
      return field.default ?? 0;
    case "boolean":
      return field.default ?? false;
    case "array":
      return field.default ?? [];
    case "string":
      return field.default ?? "";
  }
}

function orderKeys(meta: _ACPElicitationParamsMeta | undefined, keys: string[]): string[] {
  if (!isPlainObject(meta)) return keys;
  const raw = (meta as Record<string, unknown>)[META_KEY_FIELD_ORDER];
  if (!isArray(raw)) return keys;
  const keySet = new Set(keys);

  const preferred = raw.filter(isString).filter((k) => keySet.has(k));
  return uniq([...preferred, ...keys]);
}
