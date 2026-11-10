import { describe, expect, it } from "vitest";
import {
  getPermissionDeniedObservation,
  getToolCommand,
  getToolCommandHead,
  getToolCommandHeads,
  getToolCommandLabel,
  getToolDescription,
  getToolSearchQuery,
  isPermissionDeniedToolCall,
} from "./toolStatus";

describe("ACP tool status helpers", () => {
  it("identifies rejected permission tool updates", () => {
    const tool = {
      status: "failed",
      rawOutput: {
        error: true,
        observation: "user denied tool",
      },
    } as const;

    expect(isPermissionDeniedToolCall(tool)).toBe(true);
    expect(getPermissionDeniedObservation(tool)).toBe("user denied tool");
  });

  it("does not classify ordinary failed tool updates as denied", () => {
    expect(
      isPermissionDeniedToolCall({
        status: "failed",
        rawOutput: {
          error: true,
          observation: "command exited with status 1",
        },
      }),
    ).toBe(false);
  });

  it("extracts shell approval display details from ACP raw input", () => {
    const tool = {
      kind: "execute",
      title: "Run",
      rawInput: {
        cmd: 'gh pr create --title "test"',
        description: "Create a test PR",
      },
    } as const;

    expect(getToolCommand(tool)).toBe('gh pr create --title "test"');
    expect(getToolCommandHead(tool)).toBe("gh");
    expect(getToolDescription(tool)).toBe("Create a test PR");
  });

  it("extracts shell approval display details from ACP title fallback", () => {
    const tool = {
      kind: "execute",
      title: "Create a test PR: gh pr create --title test",
      rawInput: undefined,
    } as const;

    expect(getToolCommand(tool)).toBe("gh pr create --title test");
    expect(getToolCommandHead(tool)).toBe("gh");
    expect(getToolDescription(tool)).toBe("Create a test PR");
  });

  it("extracts shell approval command heads from ACP raw input commands", () => {
    const tool = {
      kind: "execute",
      title: "Run shell command",
      rawInput: { cmd: 'cd ./ && echo "hello"', commands: ["cd", "echo"] },
    } as const;

    expect(getToolCommandHeads(tool)).toEqual(["cd", "echo"]);
    expect(getToolCommandHead(tool)).toBe("cd");
    expect(getToolCommandLabel(tool)).toBe("cd, echo");
  });

  it("extracts shell commands from ACP argv raw input", () => {
    const tool = {
      kind: "execute",
      title: "Run shell command",
      rawInput: {
        command: ["/bin/zsh", "-lc", 'git commit -m "feat: improve ACP tool rendering"'],
      },
    } as const;

    expect(getToolCommand(tool)).toBe('git commit -m "feat: improve ACP tool rendering"');
    expect(getToolCommandHead(tool)).toBe("git");
    expect(getToolCommandLabel(tool)).toBe("git");
  });

  it("does not parse multiline shell command titles from their last colon", () => {
    const command = `git commit -m "$(cat <<'EOF'
feat: improve ACP tool rendering

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"`;
    const tool = {
      kind: "execute",
      title: command,
      rawInput: undefined,
    } as const;

    expect(getToolCommand(tool)).toBe(command);
    expect(getToolCommandHead(tool)).toBe("git");
    expect(getToolCommandLabel(tool)).toBe("git");
    expect(getToolDescription(tool)).toBeUndefined();
  });

  it("prefers parsed ACP commands over multiline title fallback", () => {
    const tool = {
      kind: "execute",
      title: `git commit -m "$(cat <<'EOF'
feat: improve ACP tool rendering

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"`,
      rawInput: {
        command: [
          "/bin/zsh",
          "-lc",
          `git commit -m "$(cat <<'EOF'
feat: improve ACP tool rendering

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"`,
        ],
        parsed_cmd: [
          {
            cmd: `git commit -m "$(cat <<'EOF'
feat: improve ACP tool rendering

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"`,
            type: "unknown",
          },
        ],
      },
    } as const;

    expect(getToolCommandHead(tool)).toBe("git");
    expect(getToolCommandLabel(tool)).toBe("git");
  });

  it("prefers Camber command head metadata over raw input and title fallbacks", () => {
    const tool = {
      kind: "execute",
      title: 'Change directory and greet: cd ./ && echo "hello"',
      _meta: { "camber/permission_command_heads": ["cd", "echo"] },
      rawInput: { cmd: 'cd ./ && echo "hello"', commands: ["cd"] },
    } as const;

    expect(getToolCommandHeads(tool)).toEqual(["cd", "echo"]);
    expect(getToolCommandLabel(tool)).toBe("cd, echo");
  });

  it("summarizes long shell approval command head lists like classic shell approvals", () => {
    const tool = {
      kind: "execute",
      title: "Run shell command",
      rawInput: { commands: ["cd", "npm", "git"] },
    } as const;

    expect(getToolCommandLabel(tool)).toBe("cd, npm and 1 more command");
  });

  it("uses compact command labels from ACP titles", () => {
    expect(getToolCommandLabel({ kind: "execute", title: "cd, echo" })).toBe("cd, echo");
    expect(getToolCommandLabel({ kind: "execute", title: "cd, npm and 1 more command" })).toBe(
      "cd, npm and 1 more command",
    );
  });

  it("extracts search queries from raw input", () => {
    expect(
      getToolSearchQuery({ kind: "search", title: "Search", rawInput: { query: "tool_call" } }),
    ).toBe("tool_call");
    expect(
      getToolSearchQuery({ kind: "search", title: "Grep", rawInput: { pattern: "ToolHeader" } }),
    ).toBe("ToolHeader");
  });

  it("extracts search queries from normalized search titles", () => {
    expect(getToolSearchQuery({ kind: "search", title: "Search tool_call in src/acp" })).toBe(
      "tool_call",
    );
    expect(getToolSearchQuery({ kind: "search", title: "Search ToolHeader" })).toBe("ToolHeader");
  });

  it("does not extract search queries from non-search tools", () => {
    expect(
      getToolSearchQuery({
        kind: "execute",
        title: "Search tool_call",
        rawInput: { query: "tool_call" },
      }),
    ).toBeUndefined();
  });
});
