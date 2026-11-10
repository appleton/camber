import { EditorState, TextSelection } from "prosemirror-state";
import { markdownSerializer, schema } from "../../prompt/editor/schema.js";
import {
  classifyPasteSegments,
  closeCodeBlockFence,
  hasPromptChipHtml,
  markdownTextToSlice,
} from "./code.js";

function docFromMarkdownSlice(markdown: string) {
  const state = EditorState.create({ schema });
  const slice = markdownTextToSlice(state, markdown);
  return schema.nodes.doc.create(null, slice.content);
}

describe("classifyPasteSegments", () => {
  it("splits prose-and-code mixes so only the code chunks are flagged", () => {
    const segments = classifyPasteSegments(
      `Here is some background context for the task:

const result = await fetchData(url);
console.log(result.status);

The function returns a promise. Use it like this:

if (result.status === 200) {
  processData(result.data);
}

Make sure to handle errors properly.`,
    );

    expect(segments).toEqual([
      { text: "Here is some background context for the task:", isCode: false },
      {
        text: "const result = await fetchData(url);\nconsole.log(result.status);",
        isCode: true,
      },
      { text: "The function returns a promise. Use it like this:", isCode: false },
      { text: "if (result.status === 200) {\n  processData(result.data);\n}", isCode: true },
      { text: "Make sure to handle errors properly.", isCode: false },
    ]);
  });

  it("merges consecutive code chunks back into one segment", () => {
    const segments = classifyPasteSegments(
      `function processData(input) {
  return input.split(",");
}

const result = processData("a, b, c");
console.log(result);`,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].isCode).toBe(true);
    expect(segments[0].text).toContain("function processData");
    expect(segments[0].text).toContain("console.log(result);");
  });

  it("returns no code segments for pure prose so the default paste runs", () => {
    const segments = classifyPasteSegments(
      `This is a regular paragraph of text.

This is a second paragraph with no code at all.`,
    );

    expect(segments.some((s) => s.isCode)).toBe(false);
  });
});

describe("hasPromptChipHtml", () => {
  it("matches actual Camber chip HTML by class", () => {
    expect(hasPromptChipHtml('<span class="chip-node" data-clipboard="`file.ts`"></span>')).toBe(
      true,
    );
    expect(hasPromptChipHtml('<span class="foo chip-node bar"></span>')).toBe(true);
  });

  it("does not match ordinary GitHub copied code text mentioning chip-node", () => {
    expect(
      hasPromptChipHtml(
        '<p>Adds a <code class="notranslate">chip-node</code> guard so copied chips fall back.</p>',
      ),
    ).toBe(false);
  });
});

describe("closeCodeBlockFence", () => {
  function stateWithCodeBlock(text: string, cursorOffset: number) {
    const doc = schema.node("doc", null, [
      schema.nodes.code_block.create(null, text ? schema.text(text) : null),
    ]);
    return EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1 + cursorOffset),
    });
  }

  it("exits the code block when the closing fence is typed on its own line", () => {
    const text = "const value = 1;\n``";
    const state = stateWithCodeBlock(text, text.length);

    const tr = closeCodeBlockFence(state, state.selection.from, "`");
    expect(tr).not.toBeNull();

    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).type.name).toBe("code_block");
    expect(next.doc.child(0).textContent).toBe("const value = 1;");
    expect(next.doc.child(1).type.name).toBe("paragraph");
    expect(next.selection.$from.parent).toBe(next.doc.child(1));
  });

  it("removes the block entirely when it only contains the fence", () => {
    const state = stateWithCodeBlock("``", 2);

    const tr = closeCodeBlockFence(state, state.selection.from, "`");
    expect(tr).not.toBeNull();

    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type.name).toBe("paragraph");
    expect(next.doc.child(0).content.size).toBe(0);
  });

  it("moves trailing code lines after the fence into paragraphs", () => {
    const text = "kept\n``\nafter";
    const state = stateWithCodeBlock(text, "kept\n``".length);

    const tr = closeCodeBlockFence(state, state.selection.from, "`");
    expect(tr).not.toBeNull();

    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).textContent).toBe("kept");
    expect(next.doc.child(1).type.name).toBe("paragraph");
    expect(next.doc.child(1).textContent).toBe("after");
  });

  it("accepts a closing fence with leading whitespace, like the opening rule", () => {
    const text = "const value = 1;\n  ``";
    const state = stateWithCodeBlock(text, text.length);

    const tr = closeCodeBlockFence(state, state.selection.from, "`");
    expect(tr).not.toBeNull();

    const next = state.apply(tr!);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).textContent).toBe("const value = 1;");
    expect(next.doc.child(1).type.name).toBe("paragraph");
  });

  it("ignores backticks that are not alone on their line", () => {
    const text = "value = ``";
    const state = stateWithCodeBlock(text, text.length);
    expect(closeCodeBlockFence(state, state.selection.from, "`")).toBeNull();

    const trailing = "``rest";
    const trailingState = stateWithCodeBlock(trailing, 2);
    expect(closeCodeBlockFence(trailingState, trailingState.selection.from, "`")).toBeNull();
  });

  it("ignores input that is not a backtick or not in a code block", () => {
    const state = stateWithCodeBlock("``", 2);
    expect(closeCodeBlockFence(state, state.selection.from, "a")).toBeNull();

    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("``")])]);
    const paragraphState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    expect(closeCodeBlockFence(paragraphState, 3, "`")).toBeNull();
  });
});

describe("markdownTextToSlice", () => {
  it("keeps GFM table rows contiguous when serialized", () => {
    const markdown = [
      "Before",
      "",
      "| Name | Status |",
      "| --- | --- |",
      "| Paste | Supported |",
      "| Tables | Preserved |",
      "",
      "After",
    ].join("\n");

    expect(markdownSerializer.serialize(docFromMarkdownSlice(markdown))).toBe(markdown);
  });

  it("keeps single-column GFM table rows contiguous when serialized", () => {
    const markdown = ["| Name |", "| --- |", "| Paste |"].join("\n");

    expect(markdownSerializer.serialize(docFromMarkdownSlice(markdown))).toBe(markdown);
  });

  it("adds a trailing paragraph after a final fenced code block", () => {
    const doc = docFromMarkdownSlice(["```ts", "const value = 1;", "```"].join("\n"));
    const lastChild = doc.child(doc.childCount - 1);

    expect(lastChild.type.name).toBe("paragraph");
    expect(lastChild.content.size).toBe(0);
    expect(markdownSerializer.serialize(doc)).toBe(["```", "const value = 1;", "```"].join("\n"));
  });
});
