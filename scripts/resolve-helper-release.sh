#!/usr/bin/env bash

# Resolve the highest published version in the independent helper/v* lineage.
# Set CAMBER_HELPER_VERSION to pin an exact release for a reproducible local
# build or to test a specific helper.

set -euo pipefail

helper_version="${CAMBER_HELPER_VERSION:-}"
repository="${CAMBER_HELPER_REPOSITORY:-appleton/camber}"

if [[ -n "${helper_version}" ]]; then
  [[ "${helper_version}" =~ ^helper/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "CAMBER_HELPER_VERSION must look like helper/v1.2.3" >&2
    exit 1
  }
  printf '%s\n' "${helper_version}"
  exit 0
fi

helper_version=$(gh release list \
  --repo "${repository}" \
  --limit 1000 \
  --json tagName,isDraft \
  --jq '
    [
      .[]
      | select(
          .isDraft == false and
          (.tagName | test("^helper/v[0-9]+\\.[0-9]+\\.[0-9]+$"))
        )
    ]
    | max_by(
        .tagName
        | ltrimstr("helper/v")
        | split(".")
        | map(tonumber)
      )
    | .tagName // ""
  ')

[[ -n "${helper_version}" ]] || {
  echo "No published helper/v* release exists in ${repository}" >&2
  exit 1
}
printf '%s\n' "${helper_version}"
