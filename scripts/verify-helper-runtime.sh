#!/usr/bin/env bash

# Verify the complete, immutable helper runtime asset set downloaded from or
# about to be uploaded to a helper/v* GitHub release.

set -euo pipefail

runtime_dir="${1:?usage: verify-helper-runtime.sh <runtime-directory>}"
[[ -d "${runtime_dir}" ]] || {
  echo "Helper runtime directory does not exist: ${runtime_dir}" >&2
  exit 1
}

expected=(
  camber-helper-darwin-amd64
  camber-helper-darwin-arm64
  camber-mlx-sidecar-darwin-arm64
  camber-whisper-server-darwin-arm64
)

for asset in "${expected[@]}"; do
  [[ -s "${runtime_dir}/${asset}.tar.gz" ]] || {
    echo "Missing helper runtime archive: ${asset}.tar.gz" >&2
    exit 1
  }
  [[ -s "${runtime_dir}/${asset}.checksum" ]] || {
    echo "Missing helper runtime checksum: ${asset}.checksum" >&2
    exit 1
  }
  (
    cd "${runtime_dir}"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum --check "${asset}.checksum"
    else
      shasum -a 256 --check "${asset}.checksum"
    fi
  )
done

shopt -s nullglob
archives=("${runtime_dir}"/*.tar.gz)
checksums=("${runtime_dir}"/*.checksum)
all_files=("${runtime_dir}"/*)
[[ "${#archives[@]}" == "${#expected[@]}" && \
  "${#checksums[@]}" == "${#expected[@]}" && \
  "${#all_files[@]}" == "$((2 * ${#expected[@]}))" ]] || {
  echo "Unexpected helper runtime asset set." >&2
  for file in "${all_files[@]}"; do
    printf '%s\n' "${file}" >&2
  done
  exit 1
}
