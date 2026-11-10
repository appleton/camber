---
name: camber
description: Use the camber CLI to delegate work to Camber conversations, configure agents, manage worktrees, and read agent output.
---

Run `camber skill show` and follow the guide it prints.
Use `camber <command> --help` for task-specific details.
Pass the `callerToken` from your Camber host context with `--caller-token` on `chat spawn` and `chat config set`; permission-bypass modes require it. Keep it private.
If the guide cannot load, run `camber status --json` and `camber --help`.
