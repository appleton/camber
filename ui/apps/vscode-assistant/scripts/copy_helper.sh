#!/usr/bin/env bash

# Installs helper binaries into the extension from product-release Actions
# artifacts or the newest permanent helper release.

set -euo pipefail
set -x

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# dist is ../dist relative to the script
DIST_DIR="${SCRIPT_DIR}/../dist"
# TARGET_ARCH is the target architecture to build the extension for. If omitted a universal
# extension bundling binaries for all architectures will be built.
TARGET_ARCH="${1:-}"

mkdir -p "$DIST_DIR"
cd "$DIST_DIR"

runtime_artifact_dir="${CAMBER_RUNTIME_ARTIFACT_DIR:-}"

if [[ -n "$runtime_artifact_dir" ]]; then
  [[ -d "$runtime_artifact_dir" ]] || {
    echo "Release runtime artifact directory does not exist: $runtime_artifact_dir" >&2
    exit 1
  }
  helper_version="${CAMBER_RUNTIME_VERSION:-source/unknown}"
else
  REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
  helper_repository="${CAMBER_HELPER_REPOSITORY:-appleton/camber}"
  helper_version="$(bash "$REPO_ROOT/scripts/resolve-helper-release.sh")"
fi

rm -f -- camber-helper-* camber-mlx-sidecar-* camber-whisper-server-* \
  ./*.tar.gz ./*.checksum ./*.metallib

helper_pattern=""
supplemental_patterns=()
case "$TARGET_ARCH" in
  "")
    ;;
  darwin-x64)
    helper_pattern="camber-helper-darwin-amd64.tar.gz"
    ;;
  darwin-arm64)
    helper_pattern="camber-helper-darwin-arm64.tar.gz"
    supplemental_patterns+=("camber-whisper-server-darwin-arm64.tar.gz")
    ;;
  linux-x64)
    helper_pattern="camber-helper-linux-amd64.tar.gz"
    ;;
  linux-arm64)
    helper_pattern="camber-helper-linux-arm64.tar.gz"
    ;;
  win32-x64)
    helper_pattern="camber-helper-windows-amd64.tar.gz"
    ;;
  win32-arm64)
    helper_pattern="camber-helper-windows-arm64.tar.gz"
    ;;
  *)
    echo "Unsupported target: $TARGET_ARCH" >&2
    echo "Supported targets: darwin-x64 darwin-arm64 linux-x64 linux-arm64 win32-x64 win32-arm64" >&2
    exit 1
    ;;
esac

copy_runtime_asset() {
  local pattern="$1"
  local source="$runtime_artifact_dir/$pattern"
  [[ -f "$source" ]] || {
    echo "Required release runtime artifact not found: $source" >&2
    exit 1
  }
  cp "$source" .
}

if [[ -n "$runtime_artifact_dir" ]]; then
  if [[ -n "$helper_pattern" ]]; then
    copy_runtime_asset "$helper_pattern"
    for pattern in "${supplemental_patterns[@]}"; do
      copy_runtime_asset "$pattern"
    done
  else
    for pattern in \
      camber-helper-darwin-amd64.tar.gz \
      camber-helper-darwin-arm64.tar.gz \
      camber-helper-linux-amd64.tar.gz \
      camber-helper-linux-arm64.tar.gz \
      camber-helper-windows-amd64.tar.gz \
      camber-helper-windows-arm64.tar.gz \
      camber-whisper-server-darwin-arm64.tar.gz; do
      copy_runtime_asset "$pattern"
    done
  fi
elif [[ -n "$helper_pattern" ]]; then
  gh release download "$helper_version" --repo "$helper_repository" --pattern "$helper_pattern" --clobber
  for pattern in "${supplemental_patterns[@]}"; do
    gh release download "$helper_version" --repo "$helper_repository" --pattern "$pattern" --clobber || \
      echo "Optional helper asset not found: $pattern"
  done
else
  gh release download "$helper_version" --repo "$helper_repository" --clobber
fi

shopt -s nullglob
for f in ./*.tar.gz; do
  tar -xvf "$f"
done
rm -f -- ./*.tar.gz ./*.checksum

# Local MLX inference is a Desktop-only capability. Universal helper releases
# also contain the sidecar, so make sure it cannot leak into a VSIX.
rm -f -- camber-mlx-sidecar-* ./*.metallib

binaries=(camber-helper-* camber-whisper-server-*)
if ((${#binaries[@]})); then
  chmod +x "${binaries[@]}"
fi
