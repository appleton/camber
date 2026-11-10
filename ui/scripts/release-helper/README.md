# UI release helper

Tested CLI utilities used by the tag-driven VS Code and Desktop workflows.
Run commands from this directory or through the package filter from repo root.

```bash
pnpm -F @camber/release-helper test
pnpm -F @camber/release-helper check:types
pnpm -F @camber/release-helper check:lint
```

## Release plans

`plan` writes one JSON object to stdout; diagnostics go to stderr. It resolves
the source SHA, checks `main` and previous-channel ancestry, validates an exact
bootstrap/recovery version or calculates the next version, detects affected
paths, reports the latest lineage reservation, and detects a resumable tag or
tag/SHA conflict. The workflows use `latestTag` to prevent a new version from
overtaking an incomplete GitHub draft.

`plan-products` runs those product calculations against one source and chooses
the exact version passed to each reusable release workflow. With synchronization
enabled it uses the highest active candidate. A tag already reserved at the
source SHA wins during a partial retry only while its GitHub release is
unpublished; conflicting incomplete reservations fail closed.

```bash
pnpm -F @camber/release-helper find-version plan vscode \
  --channel nightly --ref HEAD --tag-prefix vscode-assistant \
  --destination appleton.acp-assistant --dry-run

pnpm -F @camber/release-helper find-version plan desktop \
  --channel nightly --ref HEAD --tag-prefix desktop \
  --destination camber/desktop-assistant --dry-run

pnpm -F @camber/release-helper find-version plan-products \
  --channel nightly --ref HEAD --vscode --desktop --sync-versions \
  --scheduled --skip-if-no-changes \
  --vscode-destination appleton.acp-assistant \
  --vscode-display-name "Camber Assistant" \
  --desktop-destination camber/desktop-assistant
```

Important options used by the workflows:

- `--version M.m.p` and `--create-lineage`: explicit migration tools for an
  unbound lineage; `plan-products --bootstrap-version M.m.p` applies both to
  every selected product;
- `--tag-prefix <prefix>`: select the workflow's managed
  `${prefix}/vM.m.p` release lineage;
- `--destination <id>`: immutable external app identity for a managed lineage;
- `--display-name <name>`: mutable display name, held constant while resuming
  one exact version;
- `--sync-versions`: align a manual run against the maximum numeric version in
  `vscode-assistant/v*` and `desktop/v*`; `plan-products` additionally gives
  every active product the same highest exact candidate;
  existing-tag recovery may remain below the current alignment floor;
- `--scheduled --skip-if-no-changes`: disable alignment, skip before bootstrap,
  and skip when no owning paths changed since the newest product release across
  either channel;
- `--bump patch|minor|major`: stable product-local bump;
- `--main-ref origin/main`: ancestry boundary.

Both products use numeric versions: even minor is Stable and odd minor is
Preview/Nightly. SemVer suffixes and build metadata are rejected.

## Managed tag lineages

Both release workflows use one fixed managed lineage. Desktop binds its tag
prefix to one CrabNebula application; VS Code binds its tag prefix to one
Marketplace extension:

```text
vscode-assistant/v0.1.0       -> appleton.acp-assistant
desktop/v0.7.2                -> camber/desktop-assistant
```

The first tag is annotated with product, prefix, destination, version, source
SHA, and the version's display name. Every bump and retry verifies that
metadata. A prefix cannot change destinations, and one destination cannot be
bound to two prefixes. Display names may change between versions.

New lineages require an exact version and `--create-lineage`. Desktop stores the tag annotation in its
CrabNebula release notes so an existing version/channel is resumed only when
both the tag and external draft have matching provenance. VS Code packages
carry the annotation in `release-provenance.json`; retries download existing
Marketplace targets and verify it before skipping duplicates. Malformed
annotations fail closed inside the active prefix.

## First release after a repository migration

A fresh-history repository has no product tags, even when its Marketplace and
CrabNebula destinations already contain releases. Do not copy old tags or reset
external version numbers. Choose a numeric version newer than **all** existing
versions in the selected destinations, including drafts and purged CrabNebula
versions. Its minor component must be odd for Preview or even for Stable.
Keep scheduled releases disabled until the first publication is verified.

The optional `bootstrap_version` input on **Release · Products** supplies that
exact version and explicitly permits the first annotated tag for each selected
product. Leave it blank for normal releases. The existing main-ref, ancestry,
release-enable, destination, and external-version checks still apply. Bootstrap
does not bypass signing or publication checks and is rejected for schedules.
Visual Studio can participate in Preview; its Stable release remains manual.

Rehearse before publishing:

1. Run **Validate · Desktop release** and **Validate · VS Code release** with
   the intended `release` channel and `bootstrap_version`. They build unsigned
   artifacts without creating tags or publishing releases. They also work on
   a branch; the repository's canonical-repo gates must already match.
2. From `main`, run **Validate · Signed Desktop release** with the same inputs
   to exercise signing, notarization, and updater artifacts. This still does
   not reserve tags or publish. Dry-runs do not query external inventories, so
   they do not establish that the chosen version is available.
3. Inspect the uploaded artifacts and confirm the destinations' current version
   maxima again. Enable the intended product/channel release variables, then
   dispatch **Release · Products** from the frozen `main` commit with the same
   version and products. The helper runtime bootstraps independently at
   `helper/v0.0.1`; it needs no historical tags.

For a partial publication, rerun with the same bootstrap version, products,
channel, and source commit. Existing annotated tags must match the destination
and source; a retry never moves them. Once all selected products are published,
clear `bootstrap_version` on subsequent dispatches and enable the schedule.

To inspect the first plan locally without writing tags or publishing:

```bash
# Set RELEASE_VERSION to the reviewed version, not a previously published one.
pnpm -s -F @camber/release-helper find-version plan-products \
  --channel nightly --ref HEAD --main-ref origin/main \
  --bootstrap-version "$RELEASE_VERSION" --vscode --desktop --sync-versions \
  --vscode-destination appleton.acp-assistant \
  --vscode-display-name "Camber Assistant" \
  --desktop-destination camber/desktop-assistant
```

## Changelogs and channel baselines

```bash
pnpm -F @camber/release-helper find-version prev-stable desktop
pnpm -F @camber/release-helper find-version prev-nightly vscode
pnpm -F @camber/release-helper find-version changelog desktop \
  --prev desktop/v0.8.0 --head "$SHA"
pnpm -F @camber/release-helper find-version changelog vscode \
  --channel nightly --slack
pnpm -F @camber/release-helper find-version render-changelog desktop \
  --version 1.2.0 --head "$SHA" --out -
```

Changelogs are user-facing and shared by the GitHub release notes, the
CrabNebula release notes, and the stamped product `CHANGELOG.md`: first-parent
commit subjects scoped to the owning paths in `projects.yml`, grouped into
Improvements and Fixes. Excluded conventional types (chore, ci, docs, …) and
commits whose owned changes are only docs or lockfiles are dropped. Commit
hashes, authors, and repository links are omitted because the repository is
private. `--slack` emits the internal bounded mrkdwn variant, which keeps
authors and pull-request links.

`render-changelog` regenerates a product's complete `CHANGELOG.md` from its
release tag lineage at build time; the committed files stay placeholders. The
top section covers the version being built — labeled Preview and diffed
against the newest stable for nightly builds — followed by one section per
earlier stable release. History starts at `1.0.0`, which is labeled
`Initial release`; pre-1.0 releases are omitted.

A release normally compares with the previous release in the same channel.
When a channel has never released, the planner falls back to the newest
earlier tag in the product lineage instead of dumping the monorepo history; a
lineage with no earlier tag is labeled `Initial release`.

The same ownership mapping drives scheduled affected detection. Keep it
updated whenever a shipped app gains a workspace or root build dependency.
Release workflows and actions are intentionally excluded: changes to release
automation should be exercised through the validation workflows rather than
trigger a scheduled product release.
