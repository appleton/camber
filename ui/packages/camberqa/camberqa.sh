#!/usr/bin/env bash
# 🧵 CamberQA CLI — delegates to tsx for Node.js + TypeScript execution
set -euo pipefail

SELF="$0"
if [ -L "$SELF" ]; then SELF="$(readlink "$SELF")"; fi
PACKAGE_DIR="$(cd "$(dirname "$SELF")" && pwd)"

find_repo_package_dir() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/ui/packages/camberqa/src/cli.ts" ]; then
      printf '%s\n' "$dir/ui/packages/camberqa"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

CALLER_CWD="$(pwd)"
if REPO_PACKAGE_DIR="$(find_repo_package_dir "$CALLER_CWD")"; then
  PACKAGE_DIR="$REPO_PACKAGE_DIR"
fi

CAMBERQA_CALLER_CWD="$CALLER_CWD" exec pnpm --dir "$PACKAGE_DIR" exec tsx "$PACKAGE_DIR/src/cli.ts" "$@"
