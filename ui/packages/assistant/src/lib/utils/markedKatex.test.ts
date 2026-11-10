import { markedKatex } from "@camber/components/markdown";
import { marked } from "marked";
import { describe, expect, it } from "vitest";

describe("markedKatex", () => {
  marked.use(
    markedKatex({
      useExtraRules: true,
    }),
  );

  it("should render inline math with single dollars", async () => {
    const input = "This is inline math: $x = 2$";
    const result = await marked(input);

    expect(result).toContain("katex");
    expect(result).toContain("x = 2");
    expect(result).not.toContain("$"); // Should not contain raw delimiters
  });

  it("should render display math with double dollars", async () => {
    const input = "Display math:\n\n$$x = \\frac{1}{2}$$";
    const result = await marked(input);

    expect(result).toContain("katex");
    expect(result).toContain("frac{1}{2}");
    expect(result).not.toContain("$$"); // Should not contain raw delimiters
  });

  it("should render LaTeX delimiters \\(...\\) and \\[...\\]", async () => {
    const input = "Inline: \\(x = 2\\) and display: \\[y = 3\\]";
    const result = await marked(input);

    expect(result).toContain("katex");
    expect(result).toContain("x = 2");
    expect(result).toContain("y = 3");
    expect(result).not.toContain("\\("); // Should not contain raw delimiters
    expect(result).not.toContain("\\[");
  });

  it("should handle multiple expressions in one text", async () => {
    const input = "First: $a = 1$ and second: $b = 2$";
    const result = await marked(input);

    expect(result).toContain("a = 1");
    expect(result).toContain("b = 2");
    expect((result.match(/katex/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("should stop on dash", async () => {
    const input = "$a = 1$-$b = 2$";
    const result = await marked(input);

    expect(result).toContain("a = 1");
    expect(result).toContain("b = 2");
    expect((result.match(/katex/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("should handle mixed delimiter types", async () => {
    const input = "Mixed: $a$ and \\(b\\) and $$c$$ and \\[d\\]";
    const result = await marked(input);

    expect(result).toContain("katex");
    const matches = result.match(/katex/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // Should find multiple expressions
  });

  it("should NOT parse dollar amounts in financial context", async () => {
    const input = "Budget: $500M to $900K or between $100 and $200";
    const result = await marked(input);

    expect(result).not.toContain("katex");
  });

  it("should NOT parse dollars without proper spacing", async () => {
    const input = "Price$5 and cost$10 or Budget:$500M to $ 900K";
    const result = await marked(input);

    expect(result).not.toContain("katex");
  });

  it("should NOT parse attached dollar signs", async () => {
    const input = "Text$not math$more text";
    const result = await marked(input);

    expect(result).not.toContain("katex");
  });

  it("should parse LaTeX with proper spacing boundaries", async () => {
    const input = "The equation $x = 2$ is simple and $y = 3$ too";
    const result = await marked(input);

    // Should render as LaTeX because of proper spacing
    expect(result).toContain("katex");
    expect(result).toContain("x = 2");
    expect(result).toContain("y = 3");
  });

  it("should parse LaTeX at start/end and after punctuation", async () => {
    const input = "$a = 1$ and ending with $b = 2$. Formula: $E=mc^2$!";
    const result = await marked(input);

    // Should render as LaTeX
    expect(result).toContain("katex");
    expect(result).toContain("a = 1");
    expect(result).toContain("b = 2");
    expect(result).toContain("E=mc");
  });

  it("should parse LaTeX after newlines", async () => {
    const input = "Line 1\n$x = 1$\nLine 3";
    const result = await marked(input);

    // Should render as LaTeX
    expect(result).toContain("katex");
    expect(result).toContain("x = 1");
  });

  it("should not render incomplete expressions", async () => {
    const input = "Incomplete: $x = 2 and another: \\(y = 3";
    const result = await marked(input);

    expect(result).not.toContain("katex");
  });

  it("should handle empty expressions gracefully", async () => {
    const input = "Empty: $$ and \\[\\]";
    const result = await marked(input);

    expect(result).toContain("katex");
  });

  it("should handle whitespace around expressions", async () => {
    const input = "Spaces:   $  x = 1  $   and   \\(  y = 2  \\)  ";
    const result = await marked(input);

    expect(result).toContain("katex");
    expect(result).toContain("x = 1");
    expect(result).toContain("y = 2");
  });

  it("should parse LaTeX followed by a semicolon", async () => {
    const input = "you'd need $N \\geq 100$; at $p = 0.40$ you're fine";
    const result = await marked(input);

    expect(result).toContain("katex");
    expect((result.match(/katex/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(result).toContain("≥");
    expect(result).not.toMatch(/\$N \\geq 100\$/);
  });
});
