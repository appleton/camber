#!/usr/bin/env bash
set -euo pipefail

# Default values
OS_ARCH="darwin/arm64"
SHARED_FOLDER=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--shared-folder)
      [[ -n "${2-}" ]] || { echo "Missing value for --shared-folder" >&2; exit 1; }
      SHARED_FOLDER="$(realpath "$2")"
      shift 2
      ;;
    -a|--arch|--os-arch)
      [[ -n "${2-}" ]] || { echo "Missing value for --os-arch" >&2; exit 1; }
      OS_ARCH="$2"
      shift 2
      ;;
    *)
      # Check if it's a positional argument for OS_ARCH
      if [[ "$1" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$ ]]; then
        OS_ARCH="$1"
        shift
      else
        echo "Usage: $0 [os-arch] [--shared-folder <path>] [--os-arch <arch>]" >&2
        echo "  os-arch: OS/architecture (default: darwin/arm64)" >&2
        echo "  --shared-folder: Optional shared folder path to copy VSIX file" >&2
        echo "  --os-arch: OS/architecture (alternative to positional argument)" >&2
        exit 1
      fi
      ;;
  esac
done

REPO_ROOT="$(git -C . rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# build steps
node_modules/.bin/turbo build --filter=./ui/apps/vscode-assistant

# Build camber-helper for the specified OS/architecture.
scripts/helper-build-cross-platform.sh camber-helper "$OS_ARCH"

# Extract OS from OS_ARCH for file pattern matching
OS_NAME=$(echo "$OS_ARCH" | cut -d'/' -f1)

# Map OS_ARCH to vsce target
case "$OS_ARCH" in
  darwin/arm64)  VSCE_TARGET="darwin-arm64" ;;
  darwin/amd64)  VSCE_TARGET="darwin-x64" ;;
  linux/amd64)   VSCE_TARGET="linux-x64" ;;
  linux/arm64)   VSCE_TARGET="linux-arm64" ;;
  windows/amd64) VSCE_TARGET="win32-x64" ;;
  windows/arm64) VSCE_TARGET="win32-arm64" ;;
  *)
    echo "Unsupported OS_ARCH: $OS_ARCH" >&2
    exit 1
    ;;
esac

# Move binaries to VSCode extension dist folder
mv camber-helper-"${OS_NAME}"-* ui/apps/vscode-assistant/dist/

# package VSIX with platform target
VERSION=$(jq -r .version ui/apps/vscode-assistant/package.json)
VSIX_FILE="$REPO_ROOT/ui/apps/vscode-assistant/camber-assistant-${VERSION}-${VSCE_TARGET}.vsix"
pnpm -F camber-assistant exec vsce package --no-dependencies --allow-missing-repository --target "$VSCE_TARGET" \
  -o "$VSIX_FILE"

if [[ ! -f "$VSIX_FILE" ]]; then
  echo "Error: No VSIX file found" >&2
  exit 1
fi

# Move to shared folder if specified
if [[ -n "$SHARED_FOLDER" ]]; then
  mv "$VSIX_FILE" "$SHARED_FOLDER/latest.vsix"
  cp ui/apps/vscode-assistant/scripts/windows-helpers/watch-shared-vsix.ps1 "$SHARED_FOLDER"
  echo "✅ VSIX at $SHARED_FOLDER/latest.vsix"
else
  echo "✅ VSIX created at $VSIX_FILE"
fi
