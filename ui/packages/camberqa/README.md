# `@camber/camberqa`

CamberQA is Playwright-based UI automation for Camber Assistant development.
It connects to the desktop app so tests and agents can inspect, click, type,
and screenshot application flows.

## Start

From the repository root:

```sh
pnpm -F @camber/camberqa start
```

Then run:

```sh
camberqa --help
```

Use CamberQA for desktop assistant UI QA, especially when reproducing and
verifying ACP interaction bugs.

Use `camberqa webErrors` to inspect recent browser console errors and uncaught
page errors from the active target. Add `--all` to include non-error console
entries, `--limit N` to cap output, and `--clear` to reset the buffer.

## Debug And Profile

CamberQA exposes language-focused diagnostics for the helper and desktop shell:

```sh
camberqa debug go [--port PORT]
camberqa profile go <cpu|heap|goroutine|trace> [--seconds N] [-o PATH]
camberqa --desktop debug rust
camberqa --desktop profile rust cpu [--seconds N] [-o PATH] [--format pprof|svg]
```

- Go commands target `camber-helper`. `debug go` restarts the desktop helper
  under headless Delve and prints a `dlv connect` command. `profile go` reads
  the helper pprof address from helper logs and writes profiles under
  `/tmp/camberqa-profiles` by default.
- Rust commands target the desktop Tauri shell. `debug rust` prints the shell
  PID and LLDB attach commands. `profile rust cpu` is wired to the dev-only
  `camberqa-profiling` Cargo feature, but currently fails fast as unavailable
  while the Tauri profiling bridge is being stabilized.
