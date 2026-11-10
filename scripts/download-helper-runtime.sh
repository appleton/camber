#!/usr/bin/env bash

# Materialize the canonical assets for a published helper/v* release.

set -euo pipefail

tag="${1:?usage: download-helper-runtime.sh <helper-tag> <destination>}"
destination="${2:?usage: download-helper-runtime.sh <helper-tag> <destination>}"
repository="${CAMBER_HELPER_REPOSITORY:-${GITHUB_REPOSITORY:-appleton/camber}}"

[[ "${tag}" =~ ^helper/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Helper release tag must look like helper/v1.2.3: ${tag}" >&2
  exit 1
}

mkdir -p "${destination}"
gh release download "${tag}" \
  --repo "${repository}" \
  --dir "${destination}" \
  --clobber

bash "$(dirname "${BASH_SOURCE[0]}")/verify-helper-runtime.sh" "${destination}"
