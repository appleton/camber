# Contributing

Thanks for helping improve Camber Assistant.

## Development

Changes to `main` land through squash-merged pull requests. Before merging,
all required CI checks must pass against the latest `main`, and all review
conversations must be resolved.

- **[`README.md`](./README.md)**: Project overview, release downloads, and
  discussion links.
- **[`INSTALL.md`](./INSTALL.md#build-from-source)**: Set up the repo locally
  and run the assistant from source.
- **[`docs/getting-started.md`](./docs/getting-started.md)**: Choose or
  configure an agent and start using the assistant.
- **[`docs/coding-with-agents.md`](./docs/coding-with-agents.md)**: Work on
  Camber Assistant with coding agents, including camberqa, parallel
  worktrees, snapshots, and screenshots.

Before opening a large PR, read the relevant scoped
[`AGENTS.md`](./AGENTS.md). It points at the file you probably want to
edit and the conventions that live there. `CLAUDE.md` files in this repo are
symlinks to their sibling `AGENTS.md` — edit the `AGENTS.md`, and don't add a
separate `CLAUDE.md` for your own agent.

Read the desktop README before development. Shared components also serve the mobile remote companion.

- **Desktop**: [`ui/apps/desktop-assistant/README.md`](./ui/apps/desktop-assistant/README.md)

For shared UI workspace structure and package commands, use
[`ui/README.md`](./ui/README.md).

## Bugs and features

Bugs, feature requests, agent compatibility reports, rough edges, and questions —
we'd like to hear all of it. Please start in
[GitHub Discussions](https://github.com/appleton/camber/discussions)
rather than opening an issue directly.

We keep the issue tracker for accepted, well-understood work that's ready to pick
up, so every open issue is actionable. Maintainers convert discussions into
issues when the work is clear.

## Conduct

All contributors must follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
