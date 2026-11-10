# Releasing Camber

Camber ships a macOS desktop application and a versioned helper runtime.
The mobile remote UI is embedded in the helper. IDE extensions and Windows
packages are no longer built or published.

## Helper runtime

A `helper/vM.m.p` release contains macOS arm64 and amd64 helper archives,
the Apple Silicon MLX and whisper sidecars, and a SHA-256 checksum for each.
Run `scripts/verify-helper-runtime.sh <directory>` before publication.
The helper must embed the mobile UI (`pnpm -F @camber/mobile-remote embed`).
Build from a clean committed tree on Apple Silicon with:

```sh
scripts/build-macos-helper-runtime.sh 0.0.1 /tmp/camber-runtime
```

The script stamps the source commit, version and build time, builds both Mac
helper architectures, embeds the mobile UI, and builds pinned sidecars.

The initial personal-fork release is a development runtime. It is not Developer
ID signed or notarized; its release notes record that explicitly. Do not describe
it as a signed public desktop distribution. Apple signing credentials must be
configured before using the signed helper release workflow.

## Desktop application

After publishing a helper release, use **Release · Desktop** with its immutable
helper tag. The first desktop release needs an exact version and explicit
lineage creation. The workflow verifies all runtime assets before packaging.

Desktop publication stays gated by `CAMBER_RELEASES_ENABLED`, signing secrets,
and the configured distribution destination. This project currently supports
macOS only. No Windows, Visual Studio, or VS Code publishing credentials are needed.

For development, `CAMBER_DESKTOP_LOCAL_HELPER=1` builds the helper locally;
`CAMBER_HELPER_VERSION=helper/vM.m.p` pins a downloaded release.
