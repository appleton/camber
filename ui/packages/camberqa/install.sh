#!/usr/bin/env bash
# Install camberqa skill for Claude Code and Codex, plus the `camberqa` CLI command
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"
SKILL_SRC="$REPO_ROOT/.camber/skills/camberqa"
CLI_BIN="$SCRIPT_DIR/camberqa.sh"

if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "Error: SKILL.md not found at $SKILL_SRC"
  exit 1
fi

installed=()

# CLI command → ~/.local/bin/camberqa
mkdir -p "$HOME/.local/bin"
ln -sfn "$CLI_BIN" "$HOME/.local/bin/camberqa"
installed+=("cli → ~/.local/bin/camberqa")

# Claude Code
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills"
  ln -sfn "$SKILL_SRC" "$HOME/.claude/skills/camberqa"
  installed+=("claude → ~/.claude/skills/camberqa")
fi

# Codex
if [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/skills"
  ln -sfn "$SKILL_SRC" "$HOME/.codex/skills/camberqa"
  installed+=("codex → ~/.codex/skills/camberqa")
fi

for entry in "${installed[@]}"; do
  echo "Installed: $entry"
done

# Remind user to add ~/.local/bin to PATH if not already there
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
  echo ""
  echo "Add ~/.local/bin to your PATH (if not already):"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
