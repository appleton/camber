module github.com/appleton/camber

go 1.26.1

// Here to add a `replace` entry to our fork? Remember to create a vX.Y.Z tag in the fork, push it
// and use it directly, instead of those v0.0.0.-timestamp-revision entries.
// e.g. replace github.com/a/b v7.42.0 github.com/poolsideai/b v0.0.1

// workaround broken dependency - after version including https://github.com/tliron/kutil/pull/1 is used
// by lsp can remove
replace github.com/tliron/kutil v0.3.11 => github.com/tliron/kutil v0.3.26

// our fork, allowing for cancellation
replace github.com/tliron/glsp v0.2.2 => github.com/poolsideai/glsp v0.0.8

require (
	github.com/BurntSushi/toml v1.5.0 // indirect
	github.com/adrg/xdg v0.5.3
	github.com/danielgtaylor/huma/v2 v2.34.1
	github.com/go-chi/chi/v5 v5.2.4
	github.com/go-git/go-billy/v5 v5.9.0
	github.com/go-git/go-git/v5 v5.19.1
	github.com/golang-jwt/jwt/v5 v5.3.0
	github.com/golang-migrate/migrate/v4 v4.18.2
	github.com/google/go-cmp v0.7.0
	github.com/google/uuid v1.6.0
	github.com/hashicorp/golang-lru/v2 v2.0.7
	github.com/iancoleman/strcase v0.3.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mattn/go-sqlite3 v1.14.28
	github.com/muesli/termenv v0.16.0 // indirect
	github.com/pkg/errors v0.9.1
	github.com/samber/lo v1.52.0
	github.com/spf13/afero v1.15.0
	github.com/spf13/cobra v1.10.1
	github.com/stretchr/testify v1.11.1
	github.com/tliron/glsp v0.2.2
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/oauth2 v0.34.0
	golang.org/x/telemetry v0.0.0-20260409153401-be6f6cb8b1fa
	golang.org/x/tools v0.44.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/coder/acp-go-sdk v0.13.0
	github.com/creack/pty v1.1.24
	github.com/gordonklaus/ineffassign v0.2.0
	github.com/gorilla/websocket v1.5.4-0.20250319132907-e064f32e3674
	github.com/sahilm/fuzzy v0.1.1
	github.com/zalando/go-keyring v0.2.6
	honnef.co/go/tools v0.7.0
)

require (
	al.essio.dev/pkg/shellescape v1.5.1 // indirect
	dario.cat/mergo v1.0.2 // indirect
	github.com/ProtonMail/go-crypto v1.1.6 // indirect
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/cloudflare/circl v1.6.3 // indirect
	github.com/danieljoos/wincred v1.2.2 // indirect
	github.com/emirpasic/gods v1.18.1 // indirect
	github.com/go-git/gcfg v1.5.1-0.20230307220236-3a3c6141e376 // indirect
	github.com/godbus/dbus/v5 v5.1.1-0.20230522191255-76236955d466 // indirect
	github.com/jbenet/go-context v0.0.0-20150711004518-d14ea06fba99 // indirect
	github.com/kevinburke/ssh_config v1.2.0 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/kylelemons/godebug v1.1.0 // indirect
	github.com/lucasb-eyer/go-colorful v1.3.0 // indirect
	github.com/onsi/gomega v1.38.2 // indirect
	github.com/petermattis/goid v0.0.0-20240813172612-4fcff4a6cae7 // indirect
	github.com/pjbgf/sha1cd v0.6.0 // indirect
	github.com/sasha-s/go-deadlock v0.3.5 // indirect
	github.com/segmentio/ksuid v1.0.4 // indirect
	github.com/sergi/go-diff v1.3.2-0.20230802210424-5b0b94c5c0d3 // indirect
	github.com/skeema/knownhosts v1.3.1 // indirect
	github.com/tliron/commonlog v0.2.18 // indirect
	github.com/tliron/kutil v0.3.25 // indirect
	github.com/xanzy/ssh-agent v0.3.3 // indirect
	golang.org/x/exp/typeparams v0.0.0-20240314144324-c7f7c6466f7f // indirect
	golang.org/x/text v0.37.0 // indirect
	gopkg.in/warnings.v0 v0.1.2 // indirect
)

require (
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/cyphar/filepath-securejoin v0.6.1 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dustin/go-humanize v1.0.1
	github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8 // indirect
	github.com/hashicorp/errwrap v1.1.0 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/mitchellh/mapstructure v1.5.0
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/sourcegraph/jsonrpc2 v0.2.1
	github.com/spf13/pflag v1.0.10 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/mod v0.35.0
	golang.org/x/net v0.55.0
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/term v0.43.0 // indirect
)

// our fork, adds native session/delete, elastic notification buffering
// during session/load replay, and the flattened elicitation scope fields the
// generator drops (upstream SDK 0.13.6)
replace github.com/coder/acp-go-sdk => github.com/poolsideai/acp-go-sdk v0.0.0-20260731145119-52ff639a379a
