# License checks

This repository uses [Syft](https://github.com/anchore/syft) to generate a
software bill of materials and [Grant](https://github.com/anchore/grant) to
check dependency licenses against `grant.yaml`.

Run the repeatable check from the repository root:

```bash
scripts/license-check.sh
```

The script writes generated artifacts to `license-check-output/`:

- `sbom.syft.enriched.json`: Syft SBOM generated with `--enrich all`.
- `sbom.syft.enriched.patched.json`: SBOM patched with known license evidence
  gaps and local first-party artifacts removed.
- `grant.check.json`: Grant check output for the patched SBOM.
- `summary.md`: Short human-readable summary.

`license-check-output/` is generated and should not be committed.

Syft's Go package analysis uses a fixed `linux/amd64` target so the generated
package set is identical on developer machines and the Linux CI runner.

The same run also updates the checked-in
`THIRD-PARTY-DEPENDENCIES.md`. This is the human-readable package list derived
from the patched SBOM and paired with Grant's evaluation summary. The desktop
app bundles that report alongside the vendored/copied license notices.

## Why the script patches the SBOM

Syft's enrichment covers most dependency ecosystems in this repository, but a
few package managers need extra evidence:

- `pnpm-lock.yaml`: Syft enriches npm licenses from npm registry metadata, but
  those lookups drop packages. On an unchanged lockfile each run left a
  different package with no license evidence — three consecutive CI runs lost
  `@eslint/js`, then `esrap`, then `prosemirror-codemark` — and Grant denies
  packages with no license because `require-license` is enabled. Recording each
  casualty by hand never converges, so the script re-asks the registry for
  exactly the packages Syft missed. That is the same source Syft enriches from,
  so it makes enrichment repeatable rather than trusting a new one; anything the
  registry has no license for still falls through to the override map, and then
  to a failed check.

  A handful of packages fail every run rather than intermittently, because they
  publish a license file but no registry metadata to read: `cmdk-sv@0.0.19`,
  `khroma@2.1.0`, and `svelte-toolbelt@0.10.6`. Those are
  recorded as MIT in `NPM_OVERRIDES`, which also wins over anything recovered
  from the registry. Add an entry there only for a package the recovery step
  reports it could not resolve — an override matching no package in the SBOM is
  a hard error, so do not add them speculatively.
- Rust: Syft finds crates from `Cargo.lock`, but does not populate their
  licenses. The script merges license expressions from `cargo metadata
  --locked` for `ui/apps/desktop-assistant/src-tauri`.
- Swift: Syft finds packages from `cmd/camber-mlx-sidecar/Package.resolved`,
  but Swift Package Manager pins carry no license metadata. The script records
  the license declared by each upstream repository (Apache-2.0 for the Apple
  and swift-server packages, MIT for `vmlx-swift` and `yyjson`) and fails if an
  override no longer matches a pinned package.
- SPDX expressions: Grant evaluates license IDs rather than repository policy
  intent. The script normalizes common ecosystem license strings, treats simple
  dual-license `OR` expressions as acceptable when one side is allow-listed, and
  strips SPDX exception suffixes so the base license is evaluated.
- Local/first-party packages and workflows are not third-party OSS packages; the
  script removes known local artifacts from the patched SBOM before invoking
  Grant.
- GitHub Actions and the VSCE signing helper are release/workflow tooling rather
  than distributed application dependencies, so they are reported separately and
  excluded from this dependency-license policy input.

The script invokes Grant with `grant.yaml` explicitly. Grant is allow-list
based: licenses not listed there fail the check, and packages with no license
evidence fail because `require-license` is enabled. Proprietary,
source-available, strong copyleft, network-copyleft, unknown, and non-SPDX
licenses remain denied by omission.
