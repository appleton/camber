import { highlightShellCommand, parseShellCommand } from "@camber/components/assistant-ui";
import { describe, expect, it } from "vitest";

describe("parseShellCommand", () => {
  it("returns a single shell segment for plain commands", () => {
    const segments = parseShellCommand("git status");
    expect(segments).toEqual([{ kind: "shell", text: "git status" }]);
  });

  it("preserves consecutive plain shell lines as one segment", () => {
    const segments = parseShellCommand("cd /tmp\ngit status");
    expect(segments).toEqual([{ kind: "shell", text: "cd /tmp\ngit status" }]);
  });

  it("splits a single heredoc into shell + body + close-tag segments", () => {
    const cmd = "cat > knip.json << 'EOF'\n{\"a\": 1}\nEOF";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat > knip.json << 'EOF'\n" },
      { kind: "heredoc", text: '{"a": 1}\n', lang: "json" },
      { kind: "shell", text: "EOF" },
    ]);
  });

  it("infers language from the redirect target filename", () => {
    const cmd = "cat > config.yaml << 'EOF'\nkey: value\nEOF";
    const segments = parseShellCommand(cmd);
    expect(segments[1]).toEqual({ kind: "heredoc", text: "key: value\n", lang: "yaml" });
  });

  it("infers language from the heredoc tag when it matches a known flag", () => {
    const cmd = "psql <<SQL\nSELECT 1;\nSQL";
    const segments = parseShellCommand(cmd);
    expect(segments[1]).toEqual({ kind: "heredoc", text: "SELECT 1;\n", lang: "sql" });
  });

  it("supports unquoted and double-quoted tags", () => {
    expect(parseShellCommand("cat <<EOF\nbody\nEOF")[1]).toMatchObject({ kind: "heredoc" });
    expect(parseShellCommand('cat <<"EOF"\nbody\nEOF')[1]).toMatchObject({ kind: "heredoc" });
  });

  it("strips leading tabs from the close line for <<- heredocs", () => {
    const cmd = "cat <<-EOF\n\tbody\n\t\tindented\n\tEOF";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat <<-EOF\n" },
      { kind: "heredoc", text: "\tbody\n\t\tindented\n", lang: undefined },
      { kind: "shell", text: "\tEOF" },
    ]);
  });

  it("does not strip leading tabs from the close line for << heredocs", () => {
    const cmd = "cat <<EOF\nbody\n\tEOF\nEOF";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat <<EOF\n" },
      { kind: "heredoc", text: "body\n\tEOF\n", lang: undefined },
      { kind: "shell", text: "EOF" },
    ]);
  });

  it("treats the rest of the input as the body when the close tag is missing", () => {
    const cmd = "cat << EOF\nbody1\nbody2";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat << EOF\n" },
      { kind: "heredoc", text: "body1\nbody2\n", lang: undefined },
    ]);
  });

  it("handles multiple heredocs declared on the same line", () => {
    const cmd = "cat <<A; cat <<B\nbody-a\nA\nbody-b\nB";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat <<A; cat <<B\n" },
      { kind: "heredoc", text: "body-a\n", lang: undefined },
      { kind: "shell", text: "A\n" },
      { kind: "heredoc", text: "body-b\n", lang: undefined },
      { kind: "shell", text: "B" },
    ]);
  });

  it("pairs each heredoc on a shared line with its own preceding redirect target", () => {
    const cmd = "cat > a.json <<'A'; cat > b.yaml <<'B'\n{}\nA\nkey: value\nB";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat > a.json <<'A'; cat > b.yaml <<'B'\n" },
      { kind: "heredoc", text: "{}\n", lang: "json" },
      { kind: "shell", text: "A\n" },
      { kind: "heredoc", text: "key: value\n", lang: "yaml" },
      { kind: "shell", text: "B" },
    ]);
  });

  it("does not inherit a redirect target across a `;` command separator", () => {
    const cmd = "cat > a.json <<A; cat <<B\n{}\nA\nbody\nB";
    const segments = parseShellCommand(cmd);
    expect(segments[1]).toMatchObject({ kind: "heredoc", lang: "json" });
    expect(segments[3]).toMatchObject({ kind: "heredoc", lang: undefined });
  });

  it("does not inherit a redirect target across `&&`, `||`, or `|`", () => {
    expect(
      parseShellCommand("cat > a.json <<A && cat <<B\n{}\nA\nbody\nB")[3].lang,
    ).toBeUndefined();
    expect(
      parseShellCommand("cat > a.json <<A || cat <<B\n{}\nA\nbody\nB")[3].lang,
    ).toBeUndefined();
    expect(parseShellCommand("cat > a.json <<A | cat <<B\n{}\nA\nbody\nB")[3].lang).toBeUndefined();
  });

  it("ignores heredoc tokens that appear inside a trailing `#` comment", () => {
    const cmd = "cat > a.json <<A # cat <<B\n{}\nA";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([
      { kind: "shell", text: "cat > a.json <<A # cat <<B\n" },
      { kind: "heredoc", text: "{}\n", lang: "json" },
      { kind: "shell", text: "A" },
    ]);
  });

  it("returns no language when neither the tag nor the redirect target are known", () => {
    const cmd = "cat > note.unknownext << 'EOF'\nplain\nEOF";
    const segments = parseShellCommand(cmd);
    expect(segments[1].lang).toBeUndefined();
  });

  it("ignores heredoc-looking tokens inside double-quoted strings", () => {
    const cmd = 'echo "<<EOF"\nls\necho done';
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([{ kind: "shell", text: 'echo "<<EOF"\nls\necho done' }]);
  });

  it("ignores heredoc-looking tokens inside single-quoted strings", () => {
    const cmd = "echo '<<EOF'\nls";
    const segments = parseShellCommand(cmd);
    expect(segments).toEqual([{ kind: "shell", text: "echo '<<EOF'\nls" }]);
  });

  it("ignores redirect-looking tokens inside quoted strings when inferring language", () => {
    const cmd = 'echo "> not-a-file.json"; cat <<EOF\nbody\nEOF';
    const segments = parseShellCommand(cmd);
    expect(segments[1]).toMatchObject({ kind: "heredoc", lang: undefined });
  });
});

describe("highlightShellCommand", () => {
  it("highlights plain commands and returns escaped HTML", async () => {
    const html = await highlightShellCommand("echo <hi>");
    expect(html).toContain("echo");
    expect(html).not.toContain("<hi>");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });

  it("preserves and highlights a heredoc body", async () => {
    const html = await highlightShellCommand("cat > knip.json << 'EOF'\n{\"a\": 1}\nEOF");
    expect(html).toContain("&quot;a&quot;");
    expect(html).toContain("EOF");
    expect(html).toContain("<span");
  });
});
