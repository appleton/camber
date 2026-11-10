# Install Camber Assistant

To use Camber Assistant, see
[Install a prebuilt release](#install-a-prebuilt-release).

To build, modify, or contribute to Camber Assistant, see
[Build from source](#build-from-source).

## Install a prebuilt release

The [install table in the README](./README.md#install) links the latest release
for each surface. The steps below use the releases page directly.

### Desktop app on macOS Apple Silicon

1. Open the [releases page](https://github.com/appleton/camber/releases)
   and open the newest **desktop/** release.
2. Download the `.dmg` asset.
3. Open the `.dmg` and drag **Camber** to **Applications**.
4. Launch **Camber** from **Applications**.

### Start using Camber Assistant

Open Camber Assistant in the macOS desktop app. Then see
[Getting started with Camber Assistant](./docs/getting-started.md) to choose
an agent and start your first conversation.

## Build from source

Use this section if you want to run, modify, or contribute to Camber Assistant
from source.

### Prerequisites

1. Install the versions of Node.js, pnpm, Go, Bazelisk, just, and golangci-lint
   listed in [`.tool-versions`](./.tool-versions).

   You can install them manually, or install `asdf` and let `make setup` install
   them after you clone the repository. See the
   [asdf installation guide](https://asdf-vm.com/guide/getting-started.html).

2. Install **Rust** before running `make setup` or building the desktop app.
   The setup script requires `rustup` or an existing `rustc` and `cargo`
   installation so it can install the stable Rust toolchain and fetch Tauri
   dependencies. Rust is managed separately from `.tool-versions`. See the
   [Rust installation guide](https://www.rust-lang.org/tools/install).

### Clone and install

Clone the repository:

```sh
git clone git@github.com:appleton/camber.git
cd camber
```

If you use `asdf`, run:

```sh
make setup
```

This installs the pinned tool versions, installs the stable Rust toolchain with
`rustup` if needed, fetches Rust dependencies, and installs UI workspace
dependencies. If neither `rustup` nor an existing Rust toolchain is available,
`make setup` exits with an error.

Setup also installs [mr boxington](https://mr-boxington.jdx.dev) (`mbx`) into
`~/.local/bin`. It is the desktop app's cargo runner: Rust builds from every
checkout and worktree on the machine share one self-pruning cache, so building
in one worktree warms the others. If you skip `make setup`, install it with
`mise use -g mr-boxington` or `cargo install mbx --locked`.

After `make setup` installs new tools, close and reopen your terminal so they
are on your `PATH`.

If you do not use `asdf`, install the required tool versions yourself, then
run:

```sh
pnpm install
```

### Run the desktop app

The Tauri desktop assistant is the fastest surface to bring up in development
mode. From the repository root, run:

```sh
pnpm -F @camber/desktop-assistant dev
```

This launches the Tauri shell with hot reload on the Svelte side and starts a
local `camber-helper`.

### Build and test the helper

To build the helper service, run:

```sh
bazelisk build //cmd/camber-helper
```

To test the helper service, run:

```sh
bazelisk test //pkg/camber-helper/...
```

For more details, see the
[camber-helper README](./pkg/camber-helper/README.md).

### Run tests

To run all UI tests, run:

```sh
pnpm test
```

To run helper tests, run:

```sh
bazelisk test //pkg/camber-helper/...
```

To run tests for only one package, scope the command to that package:

```sh
pnpm -F @camber/desktop-assistant test:unit
pnpm -F @camber/assistant test:unit
pnpm -F @camber/desktop-assistant check:types
```

### Next steps for contributors

- [Work on Camber Assistant with coding agents](./docs/coding-with-agents.md).
- Read the scoped [`AGENTS.md`](./AGENTS.md) for the area you plan to change.

## Troubleshooting

- **The VSIX does not install or the extension does not load**: Make sure you
  downloaded the VSIX for your operating system and CPU architecture. If in
  doubt, use the universal VSIX asset.
- **macOS blocks the desktop app**: Open **System Settings > Privacy &
  Security** and allow the app to open, or Control-click the app and choose
  **Open**.
- **`make setup` fails**: Install [asdf](https://asdf-vm.com/) first, or
  install the versions in `.tool-versions` by hand.
- **Tauri build fails**: Make sure you have a Rust toolchain
  (`rustup`) installed and a recent stable version.
