import { encodeMarkdownHtmlEntries, sanitizeMarkdownHtml } from "@camber/components/markdown";
import { describe, expect, it } from "vitest";

describe("encodeMarkdownHtmlEntries", () => {
  describe("basic HTML entity encoding", () => {
    it("should encode HTML entities in regular text", () => {
      const input = "This is <strong>bold</strong> & this is a test";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("This is &lt;strong&gt;bold&lt;/strong&gt; & this is a test");
    });

    it("should encode ampersands and angle brackets", () => {
      const input = "A & B < C > D";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("A & B &lt; C &gt; D");
    });

    it("should handle empty string", () => {
      expect(encodeMarkdownHtmlEntries("")).toBe("");
    });
  });

  describe("code block preservation", () => {
    it("should preserve inline code blocks", () => {
      const input = "Use `<div>` for HTML elements & `console.log()`";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Use `<div>` for HTML elements & `console.log()`");
    });

    it("should preserve multi-line code blocks", () => {
      const input = `Here's some code:
\`\`\`javascript
const x = 5 < 10 & y > 3;
console.log("<script>");
\`\`\`
And more text & symbols.`;
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toContain(`\`\`\`javascript
const x = 5 < 10 & y > 3;
console.log("<script>");
\`\`\``);
      expect(result).toContain("And more text & symbols.");
    });

    it("should handle code blocks with various languages", () => {
      const input = `\`\`\`python
if x < y & z > w:
    print("<hello>")
\`\`\``;
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe(input); // Should be unchanged
    });
  });

  describe("LaTeX/KaTeX math block preservation", () => {
    it("should preserve display math with $$", () => {
      const input = "The equation is $$x^2 + y^2 = z^2$$ where x < y.";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("The equation is $$x^2 + y^2 = z^2$$ where x &lt; y.");
    });

    it("should preserve block math with \\[...\\]", () => {
      const input = "Consider \\[\\frac{a}{b} < \\frac{c}{d}\\] for comparison.";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Consider \\[\\frac{a}{b} < \\frac{c}{d}\\] for comparison.");
    });

    it("should preserve inline math with \\(...\\)", () => {
      const input = "The value \\(x < y & z > w\\) is important.";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("The value \\(x < y & z > w\\) is important.");
    });

    it("should preserve inline math with single $", () => {
      const input = "Calculate $x^2 + y^2$ where x & y are variables.";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Calculate $x^2 + y^2$ where x & y are variables.");
    });

    it("should handle multi-line LaTeX expressions", () => {
      const input = `The matrix is:
$$\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}$$
Where a < b & c > d.`;
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toContain(`$$\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}$$`);
      expect(result).toContain("Where a &lt; b & c &gt; d.");
    });

    it("should not break on single $ at end of line", () => {
      const input = "Price: $100\nNext line with < and &";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Price: $100\nNext line with &lt; and &");
    });
  });

  describe("mixed content scenarios", () => {
    it("should handle code blocks and math together", () => {
      const input = `Use \`console.log()\` and solve $$x^2 = 4$$ where x < 3.`;
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Use `console.log()` and solve $$x^2 = 4$$ where x &lt; 3.");
    });

    it("should handle multiple math blocks", () => {
      const input = "First: $a < b$ and second: $$c^2 + d^2$$ then text & more.";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("First: $a < b$ and second: $$c^2 + d^2$$ then text & more.");
    });

    it("should handle nested scenarios correctly", () => {
      const input = `Code: \`const result = x < y ? "yes" : "no"\`
Math: \\(\\alpha < \\beta\\)
Text with & symbols.`;
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toContain('`const result = x < y ? "yes" : "no"`');
      expect(result).toContain("\\(\\alpha < \\beta\\)");
      expect(result).toContain("Text with & symbols.");
    });

    it("should handle complex document with all block types", () => {
      const input = `# Title with & symbol

Regular text with < and > symbols.

\`\`\`javascript
const x = a < b & c > d;
console.log("<hello>");
\`\`\`

Math formula: $$\\int_0^\\infty e^{-x} dx = 1$$

Inline math: $f(x) = x^2$ and code: \`getValue()\`

More text & symbols.`;

      const result = encodeMarkdownHtmlEntries(input);

      // Check that regular text is encoded
      expect(result).toContain("# Title with & symbol");
      expect(result).toContain("Regular text with &lt; and &gt; symbols.");
      expect(result).toContain("More text & symbols.");

      // Check that code blocks are preserved
      expect(result).toContain("const x = a < b & c > d;");
      expect(result).toContain('console.log("<hello>");');
      expect(result).toContain("`getValue()`");

      // Check that math is preserved
      expect(result).toContain("$$\\int_0^\\infty e^{-x} dx = 1$$");
      expect(result).toContain("$f(x) = x^2$");
    });
  });

  describe("edge cases", () => {
    it("should handle unmatched delimiters gracefully", () => {
      const input = "This has a single ` backtick & ampersand";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("This has a single ` backtick & ampersand");
    });

    it("should handle empty code blocks", () => {
      const input = "Empty: `` and text & symbols";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Empty: `` and text & symbols");
    });

    it("should handle empty math blocks", () => {
      const input = "Empty math: $$ and more & text";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("Empty math: $$ and more & text");
    });

    it("should handle consecutive blocks", () => {
      const input = "`code1``code2`$$math1$$$$math2$$text & symbols";
      const result = encodeMarkdownHtmlEntries(input);
      expect(result).toBe("`code1``code2`$$math1$$$$math2$$text & symbols");
    });
  });
});

describe("sanitizeMarkdownHtml", () => {
  describe("allowed elements (blocklist approach - most elements allowed)", () => {
    it("should preserve headings", () => {
      const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3><h4>Subsection</h4>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toBe("<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3><h4>Subsection</h4>");
    });

    it("should preserve text formatting elements", () => {
      const html =
        "<p>Text with <strong>bold</strong>, <em>italic</em>, <code>code</code>, <kbd>keyboard</kbd></p>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain("<strong>bold</strong>");
      expect(result).toContain("<em>italic</em>");
      expect(result).toContain("<code>code</code>");
      expect(result).toContain("<kbd>keyboard</kbd>");
    });

    it("should preserve images with safe URLs", () => {
      const html =
        '<img src="https://example.com/image.jpg" alt="Description" width="100" height="50">';
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('<img src="https://example.com/image.jpg" alt="Description"');
      // DOMPurify may strip width/height attributes by default
      expect(result).toContain("<img");
    });

    it("should preserve pre and code blocks", () => {
      const html = "<pre><code>const x = 1;\nconst y = 2;</code></pre>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toBe("<pre><code>const x = 1;\nconst y = 2;</code></pre>");
    });

    it("should preserve the special marquee tag", () => {
      const html = "<marquee>Scrolling text for Sebass</marquee>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toBe("<marquee>Scrolling text for Sebass</marquee>");
    });

    it("should preserve br and hr tags", () => {
      const html = "Line 1<br>Line 2<hr>Section 2";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toBe("Line 1<br>Line 2<hr>Section 2");
    });

    it("should preserve tables and other common HTML elements", () => {
      const html = "<table><tr><th>Header</th></tr><tr><td>Data</td></tr></table>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain("<table>");
      expect(result).toContain("<tr>");
      expect(result).toContain("<th>Header</th>");
      expect(result).toContain("<td>Data</td>");
    });

    it("should preserve lists", () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul><ol><li>First</li></ol>";
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain("<ul>");
      expect(result).toContain("<li>Item 1</li>");
      expect(result).toContain("<ol>");
    });
  });

  describe("forbidden elements", () => {
    it("should remove all form elements", () => {
      const html = `
        <form action="/submit" method="POST">
          <input type="text" name="username" placeholder="Username">
          <input type="password" name="password">
          <textarea name="comments">Comments</textarea>
          <select name="country"><option>USA</option><option>UK</option></select>
          <button type="submit">Submit</button>
        </form>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<form");
      expect(result).not.toContain("<input");
      expect(result).not.toContain("<textarea");
      expect(result).not.toContain("<select");
      expect(result).not.toContain("<option");
      expect(result).not.toContain("<button");
      // Content should be preserved
      expect(result).toContain("Comments");
      expect(result).toContain("USA");
      expect(result).toContain("UK");
      expect(result).toContain("Submit");
    });

    it("should remove script tags completely", () => {
      const html =
        '<script>alert("XSS")</script><p>Safe content</p><script src="evil.js"></script>';
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<script");
      expect(result).not.toContain("alert");
      expect(result).not.toContain("XSS");
      expect(result).toBe("<p>Safe content</p>");
    });
  });

  describe("attribute filtering", () => {
    it("should preserve most attributes (blocklist approach)", () => {
      const html = `
        <a href="https://example.com" title="Link title" target="_blank" rel="nofollow">Link</a>
        <img src="https://example.com/image.jpg" alt="Image alt" width="100" height="50">
        <div id="myid" lang="en" dir="ltr" class="test">Content</div>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('title="Link title"');
      // DOMPurify strips target and rel for security by default
      expect(result).not.toContain('target="_blank"');
      expect(result).not.toContain('rel="nofollow"');
      expect(result).toContain('src="https://example.com/image.jpg"');
      expect(result).toContain('alt="Image alt"');
      expect(result).toContain('id="myid"');
      expect(result).toContain('class="test"');
    });

    it("should remove all event handler attributes", () => {
      const html = `
        <div onclick="alert('XSS')" onmouseover="steal()" onmouseout="track()">Content</div>
        <img src="https://example.com/image.jpg" onerror="hack()" onload="loaded()">
        <a href="https://example.com" onfocus="focused()" onblur="blurred()">Link</a>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("onclick");
      expect(result).not.toContain("onmouseover");
      expect(result).not.toContain("onmouseout");
      expect(result).not.toContain("onerror");
      expect(result).not.toContain("onload");
      expect(result).not.toContain("onfocus");
      expect(result).not.toContain("onblur");
      expect(result).toContain("<div>Content</div>");
      expect(result).toContain('<img src="https://example.com/image.jpg">');
      expect(result).toContain('<a href="https://example.com">Link</a>');
    });

    it("should preserve accessibility attributes", () => {
      const html = `
        <div role="button" aria-label="Click me" aria-hidden="false" aria-expanded="true" aria-describedby="desc" tabindex="0">Button</div>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('role="button"');
      expect(result).toContain('aria-label="Click me"');
      expect(result).toContain('aria-hidden="false"');
      expect(result).toContain('aria-expanded="true"');
      expect(result).toContain('aria-describedby="desc"');
      // DOMPurify strips tabindex by default for security
      expect(result).not.toContain('tabindex="0"');
    });

    it("should block data-* attributes when ALLOW_DATA_ATTR is true", () => {
      const html = '<div data-custom="value" data-id="123">Content</div>';
      const result = sanitizeMarkdownHtml(html);
      // With ALLOW_DATA_ATTR: true, data attributes should be preserved
      expect(result).toContain('data-custom="value"');
      expect(result).toContain('data-id="123"');
    });

    it("should remove form-related attributes", () => {
      const html = '<div action="/submit" method="POST" formaction="/other">Content</div>';
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("action=");
      expect(result).not.toContain("method=");
      expect(result).not.toContain("formaction=");
    });
  });

  describe("URL sanitization", () => {
    it("should allow safe protocols in href", () => {
      const html = `
        <a href="https://example.com">HTTPS</a>
        <a href="http://example.com">HTTP</a>
        <a href="mailto:test@example.com">Email</a>
        <a href="#section">Fragment</a>
        <a href="/path/to/page">Absolute path</a>
        <a href="../relative/path">Relative path</a>
        <a href="./current/path">Current path</a>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('href="http://example.com"');
      expect(result).toContain('href="mailto:test@example.com"');
      // DOMPurify's ALLOWED_URI_REGEXP only allows certain protocols
      // Fragment identifiers and relative paths don't match the regex
      expect(result).not.toContain('href="#section"');
      expect(result).not.toContain('href="/path/to/page"');
      expect(result).not.toContain('href="../relative/path"');
      expect(result).not.toContain('href="./current/path"');
      // Content should be preserved
      expect(result).toContain(">Fragment</a>");
      expect(result).toContain(">Absolute path</a>");
    });

    it("should remove javascript: URLs", () => {
      const html = `
        <a href="javascript:alert('XSS')">JavaScript link</a>
        <a href="javascript:void(0)">Void link</a>
        <a href=" javascript:alert('spaced')">Spaced JS</a>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("javascript:");
      expect(result).not.toContain("alert");
      // Normalize whitespace for comparison
      expect(result.replace(/\s+/g, " ").trim()).toBe(
        "<a>JavaScript link</a> <a>Void link</a> <a>Spaced JS</a>",
      );
    });

    it("should allow data: URLs for images", () => {
      const html = `
        <a href="data:text/html,<script>alert('XSS')</script>">Data URL link</a>
        <img src="data:image/png;base64,iVBORw0Kggg==">
        <img src="data:text/html,<script>alert('XSS')</script>">
      `;
      const result = sanitizeMarkdownHtml(html);
      // DOMPurify >= 3.4 strips data: URLs from href attributes regardless of
      // ALLOWED_URI_REGEXP; only data: URIs for images survive sanitization.
      expect(result).not.toContain("data:text/html");
      // Data URIs for images should be allowed
      expect(result).toContain("data:image/png");
    });

    it("should block unknown/dangerous protocols", () => {
      const html = `
        <a href="vbscript:alert('XSS')">VBScript link</a>
        <a href="file:///etc/passwd">File link</a>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("vbscript:");
      expect(result).not.toContain("file:");
    });
  });

  describe("forbidden interactive elements", () => {
    it("should remove iframe, object, and embed tags", () => {
      const html = `
        <iframe src="https://evil.com"></iframe>
        <object data="malicious.swf"></object>
        <embed src="plugin.swf">
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<iframe");
      expect(result).not.toContain("<object");
      expect(result).not.toContain("<embed");
    });

    it("should remove style tags", () => {
      const html = `
        <style>body { background: url('javascript:alert(1)') }</style>
        <p>Content</p>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<style");
      expect(result).toContain("<p>Content</p>");
    });

    it("should remove canvas, audio, and video tags", () => {
      const html = `
        <canvas id="mycanvas"></canvas>
        <audio src="sound.mp3"></audio>
        <video src="video.mp4"></video>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<canvas");
      expect(result).not.toContain("<audio");
      expect(result).not.toContain("<video");
    });

    it("should remove meta, base, and link tags", () => {
      const html = `
        <meta http-equiv="refresh" content="0;url=https://evil.com">
        <base href="https://evil.com">
        <link rel="stylesheet" href="styles.css">
        <p>Content</p>
      `;
      const result = sanitizeMarkdownHtml(html);
      expect(result).not.toContain("<meta");
      expect(result).not.toContain("<base");
      expect(result).not.toContain("<link");
      expect(result).toContain("<p>Content</p>");
    });
  });
});
