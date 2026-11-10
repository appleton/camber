# Keybindings

Single source of truth for the assistant's keyboard shortcuts, plus the seam
components use to attach behavior and read display hints.

## Files

| File          | Role                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts` | **The registry.** Ordered, grouped list of every command: id, title, hosts, and default chord per host. The settings UI renders this verbatim — its order is the page order. |
| `chord.ts`    | Pure chord parsing / matching / formatting. Platform passed in explicitly.                                                                                                   |
| `service.ts`  | `KeybindingService` seam + two adapters (desktop dispatch, VS Code delegated) + a dev-time audit.                                                                            |

## The two things that can be "splattered" — and only one is centralized

- **Declaration** (a command exists, its title, category, default chord, order):
  centralized in `commands.ts`. One file. Edit it to reorder the settings page.
- **Wiring** (this command, when fired, focuses the editor): stays at the
  component that owns the behavior. You can't move that into a registry without
  the registry reaching into every component.

They connect by `id`. The `CommandId` union is derived from the registry, so
`kb.register("typo")` won't compile, and `auditUnwiredCommands()` warns in dev
about commands declared with a desktop default but never wired.

## Why two adapters

The hosts resolve shortcuts differently, so the seam has two implementations
behind one interface:

- **Desktop (Tauri)** has no OS keybinding engine. `createDesktopKeybindingService`
  **owns dispatch**: a single capture-phase `keydown` handler (installed by the
  runtime) matches events against resolved bindings and fires registered handlers.
  User overrides come from a `KeybindingOverrideStore`. On desktop the runtime
  backs it with `createAcpDbKeybindingStore`, which persists to the ACP nav DB
  owned by camber-helper (`camber/acpNav/get|setKeybindings`); reads serve
  from an in-memory mirror hydrated at startup. Tests/Storybook use the default
  in-memory store.
- **VS Code** already resolves keybindings in the extension host via contributed
  `keybindings` + the `camber.webviewFocus` context key. Re-dispatching in the
  webview would double-fire, so `createDelegatedKeybindingService` **delegates**:
  `register()` / `handleKeydown()` are no-ops, and `hint()` reads the
  host-resolved hints already plumbed in over RPC (`getKeybindings`).

```
                       commands.ts  (declarations, ordered)
                            │
            ┌───────────────┴────────────────┐
   desktop adapter                    vscode adapter
   owns dispatch + overrides          delegates to the extension host
   register() runs the handler        register() is a no-op
   hint() formats resolved chord      hint() reads getKeybindings() hints
```

## Usage

```ts
const kb = getKeybindingService(); // provided by the runtime, host-appropriate

// behavior — only meaningful on hosts where the webview dispatches (desktop)
kb.register("focusInput", () => focusPrompt());

// hint — works on every host, for tooltips/menus
const hint = kb.hint("focusInput"); // "⌘I" on mac desktop, host-resolved in VS Code
```

## Keeping desktop and VS Code honest

VS Code's contributed keybindings live in `package.json` (its types derive from
it). The registry records the same defaults under each command's `vscode` key. A
drift test in the VS Code app asserts the two agree, so a default can't silently
diverge.

## Not yet wired (follow-ups)

- Generating `package.json` `contributes` from the registry instead of the
  current assert-only drift test.
