---
name: changelog
description: Generate desktop release notes from merged PRs and the desktop tag lineage.
---

# Desktop changelog

Use `ui/scripts/release-helper` and its desktop ownership map to identify changes
since the previous `desktop/v*` release. Read `RELEASING.md` first. Generate notes
with `find-version render-changelog desktop`, supplying the exact source SHA and
channel. Describe user-visible changes, group related fixes, and link their PRs.
Do not invent releases or mix helper runtime versions into desktop version history.
Preserve existing historical entries. Publishing requires explicit user intent.
