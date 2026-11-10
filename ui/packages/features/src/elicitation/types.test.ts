import { describe, expect, it } from "vitest";
import { FormModel, type FormSchema } from "./types";

// Agents split "pick an option or write your own" across two schema
// properties. The form renders one question per group, so a companion that is
// not folded in gets separated from the question it answers.
describe("FormModel.fieldGroups", () => {
  function model(properties: Record<string, unknown>, order: string[]) {
    return new FormModel(
      { type: "object", properties } as unknown as FormSchema,
      {
        "camber/field_order": order,
      } as never,
    );
  }

  const options = { type: "string", title: "Colour", oneOf: [{ const: "Red", title: "Red" }] };
  const other = { type: "string", title: "Other" };

  const names = (m: FormModel) => m.fieldGroups.map((group) => group.map((entry) => entry.name));

  it("folds a codex 'Other' answer into the question it names", () => {
    const m = model(
      {
        colour: options,
        colour_other: { ...other, _meta: { codex: { questionId: "colour", isOtherAnswer: true } } },
        size: options,
      },
      ["colour", "colour_other", "size"],
    );

    expect(names(m)).toEqual([["colour", "colour_other"], ["size"]]);
  });

  it("folds a claude-agent-acp custom field into its question by key convention", () => {
    const m = model({ question_0: options, question_0_custom: other, question_1: options }, [
      "question_0",
      "question_0_custom",
      "question_1",
    ]);

    expect(names(m)).toEqual([["question_0", "question_0_custom"], ["question_1"]]);
  });

  // Absorbing these would hide a real question behind the one above it.
  it("keeps a companion that names a different question as its own group", () => {
    const m = model(
      {
        colour: options,
        stray: { ...other, _meta: { codex: { questionId: "size", isOtherAnswer: true } } },
      },
      ["colour", "stray"],
    );

    expect(names(m)).toEqual([["colour"], ["stray"]]);
  });

  it("keeps unrelated fields in groups of their own", () => {
    const m = model({ colour: options, size: options }, ["colour", "size"]);

    expect(names(m)).toEqual([["colour"], ["size"]]);
  });
});
