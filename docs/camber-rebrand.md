# Camber fork identity

Camber is maintained at https://github.com/appleton/camber. The Go module is
`github.com/appleton/camber`; private UI workspace packages use `@camber`.
The helper executable is `camber-helper`, the app CLI is `camber`, and the UI
automation package/command is `camberqa`. Desktop builds use the bundle identifier
`io.github.appleton.camber` and the `camber://` URL scheme. The proposed VS Code
publisher is `appleton`; a marketplace account must be configured before publishing.

## Compatibility references retained deliberately

A blind replacement of every occurrence would break integrations or remove
attribution. These remaining references are intentional:

- Original Poolside copyright notices, LICENSE, NOTICE, and origin attribution.
- The upstream `poolside` ACP registry entry, `pool` executable, upstream model
  IDs (`poolside/Laguna-*`), download URLs, provider account descriptions, and the `POOLSIDE_STANDALONE_*` /
  `POOLSIDE_API_KEY` environment variables passed to that external agent.
  This rebrand does not implement the separate Pi-default migration.
- `_poolside/*` ACP extension methods understood by the upstream agent. Camber's
  own helper methods use `camber/*`; embedded upstream extension names stay intact.
- External `github.com/poolsideai/acp-go-sdk` and `github.com/poolsideai/glsp`
  dependencies and their checksums/licenses. These require a separate dependency
  replacement or fork if upstream distribution becomes unavailable.
- Existing config/state/cache/scratch locations, keychain service identifiers,
  model download markers, and `.poolside` file associations. They retain access
  to existing sessions, secrets, and downloaded data. This pass does not move
  user data. Skills also load from the new `.camber/skills` location.
- Historical performance measurements and test cases exercising those contracts.

The desktop bundle identity and VS Code settings namespace are new. Host-specific
preferences may therefore need to be imported separately; helper-owned session
and configuration paths remain unchanged. Do not run both clients against the
same state concurrently without checking their compatibility.

## Publishing

The old desktop update endpoint and signing public key are removed. Update checks
return no update while no endpoint is configured. Updater artifact creation is
disabled until a new signing key and feed are configured. Release jobs are gated
on the repository variable `CAMBER_RELEASES_ENABLED=true`; this should remain
unset until personal publishing credentials and destinations are configured.

Helper downloads now target this fork. Until it has `helper/v*` releases, build
from source with `CAMBER_DESKTOP_LOCAL_HELPER=1` instead of downloading old
upstream binaries, which speak the previous helper protocol.

## Remaining visual work

The existing logo, font glyphs, native icons, and 3D artwork retain their original
appearance. Their named files and references have been renamed, but a new Camber
visual identity is a separate design task. Do not treat this naming pass as a
completed visual rebrand or publish the inherited marks as Camber artwork.
