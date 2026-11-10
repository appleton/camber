---
name: build-local-desktop-app
description: Build and install a local macOS Camber desktop app from the current assistant repository, with the UI rebuilt and a freshly Bazel-built camber-helper embedded. Use when asked for a fresh or current local desktop build, a Camber.app bundle, or a build copied to the user's Desktop.
---

# Build Local Desktop App

Build the current checkout into an Apple Silicon macOS `Camber.app`, embed a
local `camber-helper`, validate the bundle, and copy it to the Desktop. Treat
the result as an ad-hoc-signed development build, not a notarized release.

## 1. Inspect the checkout

Work from the repository root. Read `AGENTS.md`, `ui/AGENTS.md`,
`ui/README.md`, and `ui/apps/desktop-assistant/README.md` before building.

Run:

```sh
git status --short
uname -m
pnpm --version
command -v bazelisk
rustc --version
cargo --version
```

Require `arm64` for this workflow. Preserve all user changes; do not reset or
clean the worktree. A "fresh" build means rebuilding current sources, not
discarding build caches or user edits.

Use the versions pinned in `.tool-versions`. If dependencies are missing, ask
before performing a networked install.

## 2. Rebuild the complete UI graph

Build the desktop app's entire Turbo dependency graph before invoking Tauri:

```sh
pnpm turbo build:web -F @camber/desktop-assistant --force
```

Keep `--force` for a requested fresh build. Require every task to succeed and
zero cache hits. This rebuilds shared packages such as `components`, `features`,
and `assistant`, then rebuilds the desktop Vite frontend and isolation bundle.
Running only the app's `build:web` script can consume stale shared-package
`dist` outputs.

## 3. Build the local helper and desktop app

Make the previous generated helper writable before the installer replaces it:

```sh
chmod u+w \
  ui/apps/desktop-assistant/src-tauri/binaries/camber-helper-aarch64-apple-darwin \
  2>/dev/null || true
```

Install a helper built from the checkout plus the pinned release sidecars:

```sh
env CAMBER_DESKTOP_LOCAL_HELPER=1 \
  pnpm -F @camber/desktop-assistant download:binaries
```

Run this command with filesystem escalation when Bazel uses its existing output
base under `/var/tmp`. It:

1. Bazel-builds `//cmd/camber-helper:camber-helper` from the checkout.
2. Copies it to Tauri as `camber-helper-aarch64-apple-darwin`.
3. Downloads the pinned MLX and Whisper release sidecars if needed.

Then compile and bundle the desktop app:

```sh
pnpm -F @camber/desktop-assistant tauri build
```

Tauri runs the app-level Vite frontend and isolation build again through its
`beforeBuildCommand`, now consuming the freshly rebuilt shared-package outputs.

If copying the local helper fails with `EACCES`, the existing generated sidecar
is read-only. Make it writable and rerun the full build:

```sh
chmod u+w \
  ui/apps/desktop-assistant/src-tauri/binaries/camber-helper-aarch64-apple-darwin
```

Do not edit source files to work around this generated-file permission issue.
If escalation for the installer is unavailable, build only Bazel with
escalation, copy
`bazel-bin/cmd/camber-helper/camber-helper_/camber-helper` over the Tauri
helper binary, and run `tauri build` as above.

## 4. Handle post-app bundle failures

Tauri may create the `.app`, then exit nonzero while creating the DMG inside a
sandbox or while signing the updater archive. The updater-key error is:

```text
A public key has been found, but no private key.
```

The missing updater key is expected because `createUpdaterArtifacts` is enabled
but the release-only `TAURI_SIGNING_PRIVATE_KEY` is unavailable. Do not request
or invent the release key. A local sandbox can also report a
`bundle_dmg.sh` failure after `Bundling Camber.app`.

Continue only if the log reports the current app bundle, the bundle's modified
time is from this build, and this path exists:

```text
ui/apps/desktop-assistant/src-tauri/target/release/bundle/macos/Camber.app
```

Do not ignore frontend, Rust compilation, or app-bundling failures. Deliver the
`.app`, not the DMG: the app will be locally re-signed after any DMG has already
been created.

## 5. Verify the embedded helper before signing

Set paths for the build products:

```sh
APP='ui/apps/desktop-assistant/src-tauri/target/release/bundle/macos/Camber.app'
HELPER='ui/apps/desktop-assistant/src-tauri/binaries/camber-helper-aarch64-apple-darwin'
BUNDLED_HELPER="$APP/Contents/MacOS/camber-helper"
```

Require the local and bundled helper hashes to match before changing any code
signatures:

```sh
test -d "$APP"
shasum -a 256 "$HELPER" "$BUNDLED_HELPER"
```

Both SHA-256 values must be identical. Also inspect the app version and host
architecture:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$APP/Contents/Info.plist"
file "$APP/Contents/MacOS/Camber"
```

## 6. Ad-hoc sign and validate the local app

Downloaded sidecars can contain stale embedded signatures. Verify each sidecar
and ad-hoc sign only those that fail:

```sh
for BIN in \
  "$APP/Contents/MacOS/camber-helper" \
  "$APP/Contents/MacOS/camber-mlx-sidecar" \
  "$APP/Contents/MacOS/camber-whisper-server"
do
  codesign --verify --strict "$BIN" || codesign --force --sign - "$BIN"
done
```

Then sign the outer bundle with the repository entitlements and validate it:

```sh
codesign --force --sign - \
  --entitlements ui/apps/desktop-assistant/src-tauri/Entitlements.plist \
  "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

Require `valid on disk` and `satisfies its Designated Requirement`. Do not use
`spctl` as the success check; an ad-hoc local build is intentionally not
notarized.

## 7. Copy the app to the Desktop

Use `/Users/andy/Desktop/Camber.app` unless the user requests another name.
Copy with `ditto` so bundle metadata is preserved:

```sh
ditto "$APP" '/Users/andy/Desktop/Camber.app'
```

Writing to the Desktop requires filesystem escalation. If the destination
already exists, do not merge into it or delete it silently. Ask whether to
replace it or use a different name; after approval, remove the old bundle
before copying.

Do not launch the app unless the user also asks to open it.

## 8. Verify the delivered copy

Run:

```sh
DELIVERED='/Users/andy/Desktop/Camber.app'
codesign --verify --deep --strict --verbose=2 "$DELIVERED"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$DELIVERED/Contents/Info.plist"
file "$DELIVERED/Contents/MacOS/Camber"
du -sh "$DELIVERED"
git status --short
```

Report the destination, version, architecture, successful signature check,
and that the embedded helper matched the fresh Bazel output. Mention that the
result is ad-hoc signed and not a notarized release build. Flag any unexpected
source-tree changes.
