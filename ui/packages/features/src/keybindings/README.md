# Keybindings

The command registry declares the assistant's keyboard shortcuts. Components
use `KeybindingService` to attach behavior and read display hints.

## Files

| File          | Role                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `commands.ts` | Ordered command registry: IDs, titles, groups and default chords. The settings UI uses this order. |
| `chord.ts`    | Chord parsing, matching and formatting for an explicit platform.                                   |
| `service.ts`  | Keybinding dispatch, user overrides, display hints and a development-time wiring audit.            |

## Desktop dispatch

`createDesktopKeybindingService` owns dispatch. A capture-phase `keydown`
handler matches events against resolved bindings and fires registered handlers.
Components register the behavior they own; the registry declares commands
without depending on those components.

The `CommandId` union is derived from the registry, so `kb.register("typo")`
won't compile. `auditUnwiredCommands()` warns during development about commands
with a desktop default but no registered handler.

User overrides come from a `KeybindingOverrideStore`. The desktop runtime uses
`createAcpDbKeybindingStore`, which persists to the helper's ACP navigation DB
through `camber/acpNav/getKeybindings` and `camber/acpNav/setKeybindings`.
Reads use an in-memory mirror hydrated at startup. Tests and Storybook use the
default in-memory store.

## Usage

```ts
const kb = getKeybindingService();

// Register behavior at the component that owns it.
const dispose = kb.register("focusInput", () => focusPrompt());

// Read the current shortcut for tooltips and menus.
const hint = kb.hint("focusInput");
```

Call the returned disposer when the component is destroyed. Update command
defaults in `commands.ts` and keep their handlers alongside the relevant UI.
