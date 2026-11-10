#!/usr/bin/env bash
set -euo pipefail

# Generate an enriched Syft SBOM, patch known license evidence gaps, and run Grant.
#
# Syft is built for the host through `go run`, then executed with a fixed target
# environment so Go package discovery is identical on developer machines and CI.
# Grant must be available at `$HOME/go/bin/grant` or on PATH.

SYFT_VERSION="v1.45.1"
SYFT_ANALYSIS_GOOS="linux"
SYFT_ANALYSIS_GOARCH="amd64"

OUT_DIR="license-check-output"
SKIP_SYFT=0
SKIP_GRANT=0

usage() {
  cat <<'EOF'
Usage: scripts/license-check.sh [--out-dir DIR] [--skip-syft] [--skip-grant]

Generate an enriched Syft SBOM, patch known license evidence gaps, and run Grant.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      if [[ $# -lt 2 ]]; then
        echo "--out-dir requires a value" >&2
        exit 2
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    --skip-syft)
      SKIP_SYFT=1
      shift
      ;;
    --skip-grant)
      SKIP_GRANT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 not found" >&2
    exit 1
  fi
}

find_grant() {
  if [[ -x "${HOME}/go/bin/grant" ]]; then
    printf '%s\n' "${HOME}/go/bin/grant"
    return
  fi

  if command -v grant >/dev/null 2>&1; then
    command -v grant
    return
  fi

  echo "grant not found; install Grant or place it at \$HOME/go/bin/grant" >&2
  exit 1
}

require_tool jq
require_tool go

mkdir -p "$OUT_DIR"

RAW_SBOM="${OUT_DIR}/sbom.syft.enriched.json"
PATCHED_SBOM="${OUT_DIR}/sbom.syft.enriched.patched.json"
GRANT_JSON="${OUT_DIR}/grant.check.json"
SUMMARY="${OUT_DIR}/summary.md"
DEPENDENCY_REPORT="THIRD-PARTY-DEPENDENCIES.md"

if [[ "$SKIP_SYFT" -eq 0 ]]; then
  echo "+ go run -exec 'env GOOS=${SYFT_ANALYSIS_GOOS} GOARCH=${SYFT_ANALYSIS_GOARCH}' github.com/anchore/syft/cmd/syft@${SYFT_VERSION} scan dir:. --enrich all -o syft-json=${RAW_SBOM}" >&2
  go run \
    -exec "env GOOS=${SYFT_ANALYSIS_GOOS} GOARCH=${SYFT_ANALYSIS_GOARCH}" \
    "github.com/anchore/syft/cmd/syft@${SYFT_VERSION}" \
    scan dir:. --enrich all -o "syft-json=${RAW_SBOM}"
elif [[ ! -f "$RAW_SBOM" ]]; then
  echo "--skip-syft requested, but ${RAW_SBOM} does not exist" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

NPM_OVERRIDES="${TMP_DIR}/npm-overrides.json"
cat >"$NPM_OVERRIDES" <<'JSON'
{
  "cmdk-sv@0.0.19": "MIT",
  "khroma@2.1.0": "MIT",
  "svelte-toolbelt@0.10.6": "MIT"
}
JSON

# Swift Package Manager pins (cmd/camber-mlx-sidecar/Package.resolved) carry
# no license metadata Syft can use, so record the licenses declared by each
# upstream repository. Keyed by package identity; applies to any pinned version.
SWIFT_OVERRIDES="${TMP_DIR}/swift-overrides.json"
cat >"$SWIFT_OVERRIDES" <<'JSON'
{
  "async-http-client": "Apache-2.0",
  "swift-algorithms": "Apache-2.0",
  "swift-asn1": "Apache-2.0",
  "swift-async-algorithms": "Apache-2.0",
  "swift-atomics": "Apache-2.0",
  "swift-certificates": "Apache-2.0",
  "swift-collections": "Apache-2.0",
  "swift-configuration": "Apache-2.0",
  "swift-crypto": "Apache-2.0",
  "swift-distributed-tracing": "Apache-2.0",
  "swift-http-structured-headers": "Apache-2.0",
  "swift-http-types": "Apache-2.0",
  "swift-log": "Apache-2.0",
  "swift-nio": "Apache-2.0",
  "swift-nio-extras": "Apache-2.0",
  "swift-nio-http2": "Apache-2.0",
  "swift-nio-ssl": "Apache-2.0",
  "swift-nio-transport-services": "Apache-2.0",
  "swift-numerics": "Apache-2.0",
  "swift-service-context": "Apache-2.0",
  "swift-service-lifecycle": "Apache-2.0",
  "swift-syntax": "Apache-2.0",
  "swift-system": "Apache-2.0",
  "vmlx-swift": "MIT",
  "yyjson": "MIT"
}
JSON

# Syft identifies the native esbuild executable as its embedded Go module in
# addition to the licensed @esbuild/* npm package. Go build metadata does not
# carry license evidence, so preserve the license declared by the same upstream
# project. This artifact is platform-dependent and may be absent from an SBOM.
GO_BINARY_OVERRIDES="${TMP_DIR}/go-binary-overrides.json"
cat >"$GO_BINARY_OVERRIDES" <<'JSON'
{
  "github.com/evanw/esbuild": "MIT"
}
JSON

FIRST_PARTY_PACKAGES="${TMP_DIR}/first-party-packages.json"
cat >"$FIRST_PARTY_PACKAGES" <<'JSON'
[
  "github.com/appleton/camber",
  "desktop-assistant",
  "./.github/actions/sign-darwin-binary",
  "./.github/actions/ui-setup",
  "./.github/workflows/helper-build.yml",
  "./.github/workflows/helper-release.yml",
  "./.github/workflows/reusable-bazel-build.yml"
]
JSON

missing_npm_overrides="$(
  jq -r --slurpfile overrides "$NPM_OVERRIDES" '
    $overrides[0] as $overrideMap
    | (.artifacts // [] | map(select(.type == "npm") | .name + "@" + .version)) as $npmKeys
    | $overrideMap
    | keys[]
    | select(($npmKeys | index(.)) == null)
  ' "$RAW_SBOM"
)"

if [[ -n "$missing_npm_overrides" ]]; then
  echo "npm license override targets not found in SBOM:" >&2
  printf '%s\n' "$missing_npm_overrides" >&2
  exit 1
fi

# Syft's npm enrichment is unreliable. On an unchanged lockfile it leaves a
# different package with no license evidence on nearly every run — three
# consecutive CI runs dropped @eslint/js, then esrap, then prosemirror-codemark
# — and Grant denies packages with no license because require-license is on.
# Recording each casualty by hand never converges, so ask the registry again for
# exactly the packages Syft missed. That is the same source Syft enriches from,
# so this makes enrichment repeatable rather than trusting anything new: a
# package the registry has no license for still falls through to the override
# map below, and then to a failed check.
NPM_RECOVERED="${TMP_DIR}/npm-recovered.json"
echo '{}' >"$NPM_RECOVERED"

unenriched_npm="$(
  jq -r --slurpfile overrides "$NPM_OVERRIDES" '
    $overrides[0] as $overrideMap
    | .artifacts // []
    | map(select(.type == "npm" and ((.licenses // []) | length == 0)))
    | map(.name + "@" + .version)
    | map(select($overrideMap[.] == null))
    | .[]
  ' "$RAW_SBOM"
)"

while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  # Splits scoped names correctly: @eslint/js@9.34.0 -> @eslint/js + 9.34.0.
  npm_name="${key%@*}"
  npm_version="${key##*@}"
  npm_manifest="$(
    curl --proto '=https' --tlsv1.2 --retry 5 --retry-all-errors --location \
      --silent --show-error --fail \
      "https://registry.npmjs.org/${npm_name}/${npm_version}" || true
  )"
  # `license` is a string on modern packages; the other shapes are the legacy
  # `license: {type}` object and the pre-npm5 `licenses: [{type}]` array.
  npm_license="$(
    printf '%s' "$npm_manifest" | jq -r '
      if (.license | type) == "string" then .license
      elif (.license | type) == "object" then (.license.type // empty)
      elif (.licenses | type) == "array" then (.licenses | map(.type // empty) | join(" OR "))
      else empty end
    ' 2>/dev/null || true
  )"

  if [[ -n "$npm_license" && "$npm_license" != "null" ]]; then
    jq --arg key "$key" --arg license "$npm_license" '.[$key] = $license' \
      "$NPM_RECOVERED" >"${NPM_RECOVERED}.next"
    mv "${NPM_RECOVERED}.next" "$NPM_RECOVERED"
    echo "recovered npm license from the registry: ${key} -> ${npm_license}" >&2
  else
    echo "no registry license for ${key}; it needs an entry in NPM_OVERRIDES" >&2
  fi
done <<<"$unenriched_npm"

NPM_PATCHED="${TMP_DIR}/npm-patched.json"
jq --slurpfile overrides "$NPM_OVERRIDES" --slurpfile recovered "$NPM_RECOVERED" '
  ($recovered[0] + $overrides[0]) as $overrideMap
  | .artifacts = (
      .artifacts
      | map(
          (.name + "@" + .version) as $key
          | if .type == "npm" and ($overrideMap[$key] != null) then
              .licenses = [{
                value: $overrideMap[$key],
                spdxExpression: $overrideMap[$key],
                type: "declared",
                urls: [],
                locations: []
              }]
            else
              .
            end
        )
    )
' "$RAW_SBOM" >"$NPM_PATCHED"

RUST_PATCHED="${TMP_DIR}/rust-patched.json"
CARGO_TOML="ui/apps/desktop-assistant/src-tauri/Cargo.toml"
if [[ -f "$CARGO_TOML" ]]; then
  require_tool cargo
  CARGO_METADATA="${TMP_DIR}/cargo-metadata.json"
  cargo metadata --locked --format-version 1 --manifest-path "$CARGO_TOML" >"$CARGO_METADATA"

  jq --slurpfile cargo "$CARGO_METADATA" '
    ($cargo[0].packages
      | map(select(.license != null) | {key: (.name + "@" + .version), value: .license})
      | from_entries
    ) as $licenseMap
    | .artifacts = (
        .artifacts
        | map(
            (.name + "@" + .version) as $key
            | if .type == "rust-crate" and ((.licenses // []) | length == 0) and ($licenseMap[$key] != null) then
                .licenses = [{
                  value: $licenseMap[$key],
                  spdxExpression: $licenseMap[$key],
                  type: "declared",
                  urls: [],
                  locations: []
                }]
              else
                .
              end
          )
      )
  ' "$NPM_PATCHED" >"$RUST_PATCHED"
else
  cp "$NPM_PATCHED" "$RUST_PATCHED"
fi

GO_BINARY_PATCHED="${TMP_DIR}/go-binary-patched.json"
jq --slurpfile overrides "$GO_BINARY_OVERRIDES" '
  $overrides[0] as $overrideMap
  | .artifacts = (
      .artifacts
      | map(
          if .type == "go-module"
            and .foundBy == "go-module-binary-cataloger"
            and ((.licenses // []) | length == 0)
            and ($overrideMap[.name] != null) then
            .licenses = [{
              value: $overrideMap[.name],
              spdxExpression: $overrideMap[.name],
              type: "declared",
              urls: [],
              locations: []
            }]
          else
            .
          end
        )
    )
' "$RUST_PATCHED" >"$GO_BINARY_PATCHED"

missing_swift_overrides="$(
  jq -r --slurpfile overrides "$SWIFT_OVERRIDES" '
    $overrides[0] as $overrideMap
    | (.artifacts // [] | map(select(.type == "swift") | .name)) as $swiftNames
    | $overrideMap
    | keys[]
    | select(($swiftNames | index(.)) == null)
  ' "$RAW_SBOM"
)"

if [[ -n "$missing_swift_overrides" ]]; then
  echo "swift license override targets not found in SBOM:" >&2
  printf '%s\n' "$missing_swift_overrides" >&2
  exit 1
fi

SWIFT_PATCHED="${TMP_DIR}/swift-patched.json"
jq --slurpfile overrides "$SWIFT_OVERRIDES" '
  $overrides[0] as $overrideMap
  | .artifacts = (
      .artifacts
      | map(
          if .type == "swift" and ((.licenses // []) | length == 0) and ($overrideMap[.name] != null) then
            .licenses = [{
              value: $overrideMap[.name],
              spdxExpression: $overrideMap[.name],
              type: "declared",
              urls: [],
              locations: []
            }]
          else
            .
          end
        )
    )
' "$GO_BINARY_PATCHED" >"$SWIFT_PATCHED"

REMOVED_FIRST_PARTY="${TMP_DIR}/removed-first-party.json"
jq --slurpfile firstParty "$FIRST_PARTY_PACKAGES" '
  .artifacts
  | map(select((.name as $name | $firstParty[0] | index($name)) != null))
  | unique_by(.type, .name, .version)
' "$SWIFT_PATCHED" >"$REMOVED_FIRST_PARTY"

EXCLUDED_POLICY_SCOPE="${TMP_DIR}/excluded-policy-scope.json"
jq --slurpfile firstParty "$FIRST_PARTY_PACKAGES" '
  def is_policy_scope_excluded:
    (.type == "github-action" or .type == "github-action-workflow")
    or (.type == "npm" and ((.name // "") | startswith("@vscode/vsce-sign")));

  .artifacts
  | map(select((.name as $name | $firstParty[0] | index($name)) == null))
  | map(select(is_policy_scope_excluded))
  | unique_by(.type, .name, .version)
' "$SWIFT_PATCHED" >"$EXCLUDED_POLICY_SCOPE"

jq --slurpfile firstParty "$FIRST_PARTY_PACKAGES" '
  def trim:
    sub("^ +"; "") | sub(" +$"; "");

  def is_policy_scope_excluded:
    (.type == "github-action" or .type == "github-action-workflow")
    or (.type == "npm" and ((.name // "") | startswith("@vscode/vsce-sign")));

  def allowed_or_alternative:
    [
      "0BSD",
      "CC0-1.0",
      "Unlicense",
      "WTFPL",
      "Apache-2.0",
      "Apache-1.1",
      "MIT",
      "MIT-0",
      "ISC",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "BSD-4-Clause",
      "BSD-Source-Code",
      "BlueOak-1.0.0",
      "BSL-1.0",
      "Zlib",
      "Libpng",
      "IJG",
      "NCSA",
      "PostgreSQL",
      "Python-2.0",
      "Ruby",
      "X11",
      "MPL-2.0",
      "Artistic-2.0",
      "Unicode-3.0",
      "CC-BY-3.0"
    ] as $allowed
    | . as $license
    | if (contains(" OR ") and (contains(" AND ") | not)) then
        (gsub("[()]"; "")
          | split(" OR ")
          | map(trim)
          | map(select($allowed | index(.)))
          | .[0]) // $license
      else
        .
      end;

  def normalize_license:
    if type == "string" then
      gsub("[[:space:]]+"; " ")
      | sub("^ "; "")
      | sub(" $"; "")
      | gsub("(?i) WITH [A-Za-z0-9.-]+"; "")
      | if . == "Apache License 2.0" then "Apache-2.0" else . end
      | if . == "BSD" then "BSD-3-Clause" else . end
      | if startswith("BSD 3-Clause License ") then "BSD-3-Clause" else . end
      | if . == "MIT/Apache-2.0" then "MIT OR Apache-2.0" else . end
      | if . == "Apache-2.0/MIT" or . == "Apache-2.0 / MIT" then "Apache-2.0 OR MIT" else . end
      | if . == "BSD-3-Clause/MIT" then "BSD-3-Clause OR MIT" else . end
      | if . == "Unlicense/MIT" then "Unlicense OR MIT" else . end
      | allowed_or_alternative
    else
      .
    end;

  .artifacts = (
    .artifacts
    | map(select((.name as $name | $firstParty[0] | index($name)) == null))
    | map(select(is_policy_scope_excluded | not))
    | map(
        .licenses = (
          (.licenses // [])
          | map(
              (if (.spdxExpression // "") != "" then .spdxExpression else (.value // "") end | normalize_license) as $license
              | .spdxExpression = $license
              | .value = $license
            )
        )
      )
  )
' "$SWIFT_PATCHED" >"$PATCHED_SBOM"

jq -r \
  --arg patched "$PATCHED_SBOM" \
  --arg grant "$GRANT_JSON" \
  --slurpfile removed "$REMOVED_FIRST_PARTY" \
  --slurpfile excluded "$EXCLUDED_POLICY_SCOPE" '
  def license_value:
    .spdxExpression // .value // "";

  def type_counts($items):
    $items
    | group_by(.)
    | map({name: .[0], count: length})
    | sort_by(.count)
    | reverse;

  .artifacts as $artifacts
  | ($artifacts | map(.type // "unknown") | type_counts(.)) as $byType
  | ($artifacts | map(select((.licenses // []) | length > 0) | .type // "unknown") | type_counts(.)) as $licensed
  | ($artifacts | map(select((.licenses // []) | length == 0) | .type // "unknown") | type_counts(.)) as $unlicensed
  | ($artifacts
      | map(. as $artifact
          | (.licenses // [])
          | map(license_value)
          | map(select(test("\\b(AGPL|GPL|LGPL|MPL|CDDL|EPL|Artistic|CC-BY)(-|/|\\b)"; "i")))
          | map({
              type: ($artifact.type // "unknown"),
              name: $artifact.name,
              version: $artifact.version,
              license: .
            })
        )
      | flatten
    ) as $copyleft
  | [
      "# License check summary",
      "",
      "Patched SBOM: `" + $patched + "`",
      "Grant JSON: `" + $grant + "`",
      "",
      "## Artifact counts",
      "",
      ($byType[]? | "- " + .name + ": " + (.count | tostring)),
      "",
      "## Licensed by type",
      "",
      ($licensed[]? | "- " + .name + ": " + (.count | tostring)),
      "",
      "## Unlicensed by type",
      "",
      (
        if ($unlicensed | length) > 0 then
          ($unlicensed[] | "- " + .name + ": " + (.count | tostring))
        else
          "None."
        end
      ),
      "",
      "## Removed first-party artifacts",
      "",
      (
        if ($removed[0] | length) > 0 then
          ($removed[0][] | "- " + (.type // "unknown") + " `" + (.name // "") + "@" + (.version // "") + "`")
        else
          "None."
        end
      ),
      "",
      "## Excluded policy-scope artifacts",
      "",
      (
        if ($excluded[0] | length) > 0 then
          ($excluded[0][] | "- " + (.type // "unknown") + " `" + (.name // "") + "@" + (.version // "") + "`")
        else
          "None."
        end
      ),
      "",
      "## Copyleft / weak-copyleft findings",
      "",
      (
        if ($copyleft | length) > 0 then
          ($copyleft[:100][] | "- " + .type + " `" + (.name // "") + "@" + (.version // "") + "`: `" + .license + "`")
        else
          "None found in patched SBOM."
        end
      ),
      ""
    ]
  | .[]
' "$PATCHED_SBOM" >"$SUMMARY"

GRANT_STATUS=0
if [[ "$SKIP_GRANT" -eq 0 ]]; then
  GRANT="$(find_grant)"
  set +e
  "$GRANT" check "$PATCHED_SBOM" -c grant.yaml -o json >"$GRANT_JSON"
  GRANT_STATUS=$?
  set -e

  {
    echo
    echo "## Grant result"
    echo
    jq -r '
      try (
        .run.targets[0].evaluation as $evaluation
        | "- status: `" + $evaluation.status + "`",
          "- summary: `" + ($evaluation.summary | tojson) + "`"
      ) catch (
        "Could not parse Grant JSON."
      )
    ' "$GRANT_JSON"
    echo
  } >>"$SUMMARY"

  scripts/render-license-report.sh "$PATCHED_SBOM" "$GRANT_JSON" "$DEPENDENCY_REPORT"
fi

echo "wrote ${PATCHED_SBOM}"
if [[ "$SKIP_GRANT" -eq 0 ]]; then
  echo "wrote ${GRANT_JSON}"
  echo "wrote ${DEPENDENCY_REPORT}"
fi
echo "wrote ${SUMMARY}"

exit "$GRANT_STATUS"
