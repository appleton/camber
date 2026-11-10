# Camber Assistant

**An AI coding assistant for macOS.**

Camber Assistant is an open-source client for coding agents. Use it from the macOS desktop app.

Connect agents that support the
[Agent Client Protocol](https://agentclientprotocol.com/), including
Codex, Claude, and other compatible agents.

Chat with agents locally and control desktop sessions from your phone.

## Features

- **Universal ACP client.** Use compatible agents such as Claude, Codex, and
  Cursor, install community agents from the
  [Agent Client Protocol](https://agentclientprotocol.com/) registry, or bring
  your own agent.
- **Desktop workflows for larger changes.** Use worktrees, GitHub awareness,
  built-in terminals, and change review tools from the desktop app.
- **Optional on-device models.** In the desktop app on Apple Silicon,
  download and run supported models locally.
- **Remote access.** Drive your desktop assistant from your phone over
  Tailscale.
- **Voice input.** Dictate prompts instead of typing them.
- **Open source.** Apache-2.0 licensed, free to use, modify, and ship in
  your own developer environment. Contributions welcome.

## Install

Desktop installers have not been published yet. Build from source for now;
the links below are the destinations for future releases.

| Surface                             | Status    | Download                                                                                                      |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| **Desktop** — macOS (Apple Silicon) | Planned | [Newest `desktop/v*` release](https://github.com/appleton/camber/releases?q=desktop%2Fv)                  |

For install instructions, see
[Install a prebuilt release](./INSTALL.md#install-a-prebuilt-release). After
installing, see
[Getting started with Camber Assistant](./docs/getting-started.md) to choose
an agent and start a conversation.

## Issues and discussions

Bugs, feature requests, agent compatibility reports, rough edges, and questions —
we'd like to hear all of it. Please start in
[GitHub Discussions](https://github.com/appleton/camber/discussions)
rather than opening an issue directly.

We keep the issue tracker for accepted, well-understood work that's ready to pick
up, so every open issue is actionable. Maintainers convert discussions into
issues when the work is clear.

This model is based on
[Ghostty's contribution process](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md),
which keeps discussions and actionable work separate.

## Contributing

For development docs, app README links, and contribution guidelines, see
[Contributing](./CONTRIBUTING.md). If you use a coding agent to work on this
repository, see
[Working on Camber Assistant with coding agents](./docs/coding-with-agents.md).
Dependency license policy docs live in
[License checks](./docs/license-checks.md).

## License

Camber Assistant's source code and client applications are licensed under the
[Apache License 2.0](./LICENSE). Third-party components retain their own licenses;
see [Third-party licenses](./THIRD-PARTY-LICENSES.md).

Agents and services you connect to through Camber Assistant are subject to
their own licenses and terms.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

## Origin

Camber was forked from the Poolside Assistants and is independently maintained by
[Andy Appleton](https://github.com/appleton). Original copyright notices and
third-party licenses are retained.

See [the rebrand notes](docs/camber-rebrand.md) for compatibility details.
