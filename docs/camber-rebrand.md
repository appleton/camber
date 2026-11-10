# Camber fork identity

Camber is maintained at https://github.com/appleton/camber. The Go module is
`github.com/appleton/camber`; private UI workspace packages use `@camber`.
The helper executable is `camber-helper`, the app CLI is `camber`, and the UI
automation package/command is `camberqa`. Desktop builds use the bundle identifier
`io.github.appleton.camber` and the `camber://` URL scheme. Only the macOS desktop app is distributed; the mobile web UI remains its remote companion.

## Compatibility references retained deliberately

A blind replacement of every occurrence would break integrations or remove
attribution. These remaining references are intentional:

- Original Poolside copyright notices, LICENSE, NOTICE, and origin attribution.
- The upstream `poolside` ACP registry entry, `pool` executable, upstream model
  IDs (`poolside/Laguna-*`), download URLs, provider account descriptions, and the `POOLSIDE_STANDALONE_*` /
  `POOLSIDE_API_KEY` environment variables passed to that external agent.
  The current default agent ID is still `poolside`; `default` remains a legacy
  alias. This documentation cleanup does not implement the separate Pi-default migration.
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

The desktop bundle identity is new. Host-specific
preferences may therefore need to be imported separately; helper-owned session
and configuration paths remain unchanged. Do not run both clients against the
same state concurrently without checking their compatibility.

## Configuration paths

The default agent configuration file is `~/.config/poolside/assistant.json`.
With `XDG_CONFIG_HOME` set, it is
`$XDG_CONFIG_HOME/poolside/assistant.json`. `CAMBER_ASSISTANT_CONFIG_PATH`
overrides the full path in both the desktop app and helper.

## Publishing

The old desktop update endpoint and signing public key are removed. Update checks
return no update while no endpoint is configured. Updater artifact creation is
disabled until a new signing key and feed are configured. Release jobs are gated
on the repository variable `CAMBER_RELEASES_ENABLED=true`; this should remain
unset until personal publishing credentials and destinations are configured.

Helper downloads target this fork, which publishes `helper/v*` runtime releases.
Use `CAMBER_DESKTOP_LOCAL_HELPER=1` to build from source instead. Old upstream
binaries speak the previous helper protocol and are not compatible.

## Remaining visual work

The existing logo, font glyphs, native icons, and 3D artwork retain their original
appearance. Their named files and references have been renamed, but a new Camber
visual identity is a separate design task. Do not treat this naming pass as a
completed visual rebrand or publish the inherited marks as Camber artwork.
