# Desktop release helper

The release planner owns the desktop and helper tag histories. Product ownership
is defined in `projects.yml`; only the desktop application is shipped.

```sh
pnpm -F @camber/release-helper find-version plan desktop --channel nightly --ref HEAD
pnpm -F @camber/release-helper find-version plan-helper --ref HEAD
pnpm -F @camber/release-helper test:unit
```

The first desktop release requires an exact version, destination, tag prefix and
explicit `--create-lineage`. Published tags are immutable; retries verify source
SHA and metadata. Preview versions have odd minor numbers; stable versions have
even minor numbers. Helper releases increment independently under `helper/v*`.
See the root `RELEASING.md` for build and publication requirements.
