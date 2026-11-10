#!/usr/bin/env bash

set -euo pipefail

# Helper script to build the VS Code extension with the local version of helper
# compiled. Defaults to 'darwin' for OS and 'arm64' for arch.
# Usage:
#    ./scripts/build_vscode_assistant_local.sh --os <os> --arch <arch>

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --os) GOOS="$2"; shift ;;
        --arch) GOARCH="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

set -x

# Default values if not provided
LDFLAGS=""
GOOS=${GOOS:-"darwin"}
GOARCH=${GOARCH:-"arm64"}
OUTPUT_BINARY="camber-helper-${GOOS}-${GOARCH}"

if [[ $GOOS == "windows" ]]; then
  LDFLAGS+=" -linkmode external -extldflags \"-static\""
fi

# Build extension code.
./node_modules/.bin/turbo build --filter="./ui/apps/vscode-assistant"

# Build camber helper.
GOOS=$GOOS GOARCH=$GOARCH CGO_ENABLED=1 go build -tags=fts5 -ldflags "-s -w $LDFLAGS" -buildvcs=false -mod=readonly -o "$OUTPUT_BINARY" ./cmd/camber-helper

mv camber-helper-* ./ui/apps/vscode-assistant/extension

# Package extension for VS Code.
pnpm -F camber-assistant run package
