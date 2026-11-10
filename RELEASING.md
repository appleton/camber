# Releasing

VS Code and Desktop releases are tag-driven. Committed manifests stay at
`0.0.0`; the workflows calculate a version and stamp only the artifacts. Visual
Studio remains a separate product release, but it consumes the helper releases
produced by VS Code and Desktop.

| Product | Stable | Preview |
| --- | --- | --- |
| VS Code | even minor; Marketplace release | odd minor; Marketplace pre-release |
| Desktop | even minor; CrabNebula default channel | odd minor; CrabNebula `nightly` channel |

Versions are numeric SemVer without suffixes. Desktop can remain on `0.x` until
the product is ready to declare 1.0.

## Identities and tags

- VS Code uses `vscode-assistant/vM.m.p` and publishes
  `appleton.${VSCODE_EXTENSION_NAME}`. It currently resolves to
  `appleton.acp-assistant`.
- Desktop uses `desktop/vM.m.p` and publishes to `CN_APP_SLUG`, currently
  `camber/desktop-assistant`.
- The new VS Code extension is unrelated to the legacy extension. Old
  `vscode/v*` tags never participate in versioning, changelogs, or sync.

The first managed tag binds a tag prefix to its external application. Every
later release verifies that annotation, preventing a lineage from accidentally
publishing another Marketplace extension or CrabNebula application.

## Product releases

Use **Release · Products** for the normal release train. Manual runs select a
release type and whether to include VS Code, Desktop, or both; both products and
version synchronization are enabled by default.

The coordinator plans every selected product from one dispatch-time `main` SHA
before either product creates a tag. With synchronization enabled, it passes one
exact highest candidate to every active product, so release order cannot move
the second product to another patch version. If a partial run is retried, an
existing unpublished product tag at that SHA reserves the coordinated version
for the other product. Tags whose GitHub releases are already published are
treated as completed history rather than interrupted reservations.

Before either product package is built, the coordinator allocates the next
independent `helper/vM.m.p` patch version, then builds and signs one shared set
of `camber-helper`, MLX, and whisper-server artifacts from that exact source
SHA. It publishes that exact set as a permanent GitHub helper release before VS
Code or Desktop may publish. Both product-only workflows download and verify
that immutable helper release before packaging. The individual VS Code and
Desktop buttons are thin wrappers around the same coordinator with only that
product selected, so they use the same helper lifecycle without duplicating it
inside the product workflow.

The GitHub helper release is the durable copy and has no automatic expiration.
The matching Actions artifacts are only cross-job transport and are retained
for seven days to support workflow retries.

The same workflow owns the daily 04:00 UTC Preview schedule. It excludes
products with no relevant owning-path changes. When both products changed they
receive the same version; when only one changed, only that product releases and
the other can catch up on a later release. Helper, embedded mobile UI, and their
shared build-input changes are owned by both products; the Desktop-only MLX
sidecar is owned only by Desktop.

Use **Re-run failed jobs** after a partial failure. Do not start another release
while a coordinated or individual release is incomplete.

## VS Code releases

Use **Release · VS Code** only when VS Code must be released independently. It
has two inputs:

- `release`: `preview`, `stable-patch`, `stable-minor`, or `stable-major`;
- `sync_versions`: enabled by default, aligning the result with the highest
  managed VS Code/Desktop version without releasing the other product.

The workflow always uses the dispatch-time `main` commit, the
`vscode-assistant` tag lineage, and the repository's configured Marketplace
identity. Stable and Preview releases can both be dispatched manually.

Use **Validate · VS Code release** to calculate, build, test, and package the
same selection without creating a tag, GitHub release, Marketplace version, or
Slack success notification. The validation workflow first builds a temporary
runtime and then invokes the same product-only packaging workflow.

An individual retry reuses the immutable tag and the runtime/build artifacts
from the original run, and skips Marketplace targets that were already
published.

## Desktop releases

Use **Release · Desktop** only when Desktop must be released independently. It
has the same two inputs as VS Code:

- `release`: `preview`, `stable-patch`, `stable-minor`, or `stable-major`;
- `sync_versions`: enabled by default.

No new CrabNebula application or 1.0 bump is required. Preview publishes to the
`nightly` channel; Stable publishes to the default channel of the same app. The
workflow always uses the dispatch-time `main` commit, the `desktop` tag lineage,
and the configured `CN_APP_SLUG`.

Use **Validate · Desktop release** for an unsigned build from any branch. It
calculates the same version, runs tests, packages the app, and writes no tags or
external releases. Use **Validate · Signed Desktop release** from `main` to also
exercise Apple signing, notarization, and updater artifacts using the selected
channel's release environment. Both validations prepare their temporary
runtime before invoking the product-only packaging workflow.

An individual retry verifies the tagged source and CrabNebula provenance,
restores the runtime/build artifacts from the original run, and resumes the same
version.

## Repository configuration

Publication is disabled unless these repository variables are exactly `true`:

- `VSCODE_RELEASES_ENABLED` or `DESKTOP_RELEASES_ENABLED` for the product;
- `NIGHTLY_RELEASES_ENABLED` for Preview publication.

Identity variables:

- `VSCODE_EXTENSION_NAME` and `VSCODE_EXTENSION_DISPLAY_NAME`;
- `CN_APP_SLUG`;
- `APPLE_API_ISSUER` and `APPLE_API_KEY`;
- `SLACK_RELEASE_CHANNEL_ID` for best-effort release notifications.

Signed and live release jobs use these environments, restricted to the exact
`main` branch:

- `vscode-nightly-release` and `vscode-stable-release`;
- `desktop-nightly-release` and `desktop-stable-release`.

Unsigned builds use `desktop-dry-run`; it contains no secrets and permits
validation branches.

Release environments do not require deployment approval. Stable releases are
protected by being manual-only, and every release environment accepts
deployments only from `main`.

Creating product and helper release tags requires the repository-level
`RELEASE_GIT_TOKEN`.
GitHub's built-in Actions token cannot create a tag whose commit range includes
workflow changes. Use a fine-grained personal access token limited to this
repository with `Contents: Read and write` and `Workflows: Read and write`, and
rotate it according to its configured expiration. The workflows use this
credential only to push a new annotated release tag; retries that reuse an
existing tag continue to use the built-in token.

The current Marketplace credential is the repository-level
`VSCODE_MARKETPLACE_TOKEN`; keep it there until the token can be re-entered into
both VS Code environments. The release workflow cannot expose or copy an
existing GitHub secret.

The current Desktop publication/signing credentials are also repository-level:

- `CN_API_KEY`;
- `MACOS_DEVID_P12_B64` and `MACOS_DEVID_P12_PASSWORD`;
- `ASC_KEY_P8_B64`;
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep them there until each value can be re-entered into both Desktop release
environments. GitHub cannot expose or copy the existing secret values.

Release notifications use the repository-level `SLACK_BOT_TOKEN` with
`chat:write` and the `SLACK_RELEASE_CHANNEL_ID` repository variable. Slack
delivery is best-effort and never changes a release result. Notifications name
manual Preview releases as Unstable, scheduled Preview releases as Nightly
(unstable), and production releases as Stable. Their bounded change list links
pull-request numbers and names commit authors.

Protect `vscode-*/v*`, `desktop/v*`, and `helper/v*` from update or deletion
while allowing the release workflows to create them.

## VS Code Marketplace authentication

The current workflow uses an existing Azure DevOps PAT with
`Marketplace: Manage`. `vsce login` is not required by GitHub Actions. For a
local login, include the publisher and paste the PAT when prompted:

```bash
pnpm -F camber-assistant exec vsce login appleton
```

Azure DevOps stopped creating new global PATs on March 15, 2026 and will retire
existing global PATs on December 1, 2026. Before then, migrate the workflow to
Microsoft Entra workload identity and `vsce publish --azure-credential`. That
requires a federated identity created by an Azure administrator.

See the official
[VS Code publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
and the
[global PAT retirement schedule](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).

## Release mechanics

Before an external product publish, each workflow creates an immutable
annotated product tag, an invisible GitHub draft, and a SHA-256-addressed
archive of the complete artifact set. It publishes the product GitHub release
only after the external store succeeds, then removes the internal archive.

Changelogs are user-facing: first-parent commit subjects scoped to product
ownership from `projects.yml`, grouped into Improvements and Fixes, with
chore-type and docs/lockfile-only commits dropped. The same markdown feeds the
GitHub release notes, the CrabNebula release notes, and each product's
`CHANGELOG.md`, which is regenerated from the release tag history and stamped
into the build (committed files stay placeholders). The same ownership mapping
lets the coordinator decide which products participate in a scheduled Preview
release. It tracks shipped and build inputs, not release automation; workflow
changes should be exercised through the validation workflows.

Stamped changelog history starts at `1.0.0`, labeled `Initial release`.
Pre-1.0 releases are omitted; later releases retain their normal scoped notes.

The changelog baseline is the previous release in the same channel. If a
channel has no previous release—such as the first Stable following Preview
bootstrap releases—the newest earlier product tag is used instead. A genuinely
new lineage with no earlier product tag is reported as an initial release
rather than listing the monorepo's history.

Helper versions are independent from product versions and always advance as a
patch lineage (`helper/v0.0.394`, `helper/v0.0.395`, and so on). The same source
SHA reuses its existing helper tag and published assets on a retry.

Product releases build the helper and supported sidecars from the product
release SHA and publish that runtime as a non-draft GitHub release. Live
product packaging always downloads those immutable release assets; temporary
Actions artifacts are used only by dry runs. A retry for an already-published
helper reuses its assets without rebuilding.

The product manifests do not pin helper versions. Fresh local binary installs
and Visual Studio resolve the highest published `helper/v*` version. Desktop
development then reuses complete local `.version` stamps without a GitHub API
call; use `download:binaries:refresh` to check for a newer release. Set
`CAMBER_HELPER_VERSION=helper/vM.m.p` to reproduce an exact runtime.

Use **Release · Helper** only for an exceptional helper-only release. It runs
the same planner, signed build, immutable tag, and permanent publication path
without publishing VS Code or Desktop.

Implementation details:

- [release-helper](ui/scripts/release-helper/README.md)
- [Desktop updater](ui/apps/desktop-assistant/AUTOUPDATER.md)
- [helper release](pkg/camber-helper/README.md)
