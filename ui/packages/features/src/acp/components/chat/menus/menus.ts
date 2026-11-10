import type { MenuProps } from "@camber/components/prompt";

export const acpMenus = {
  command: {
    rules: [
      {
        trigger: "/",
        triggerRegExp: /(?<=^|\s)\/(?!\s)/g,
        // Pushed config menus complete to `/command ` and use the remaining
        // text as their filter query.
        queryRegExp: /^\S*(?:\s.*)?$/,
      },
    ],
    value: "acp-command",
  },
  skills: {
    rules: [
      {
        trigger: "$",
        triggerRegExp: /(?<=^|\s)\$(?!\s)/g,
        queryRegExp: /^\S*$/,
      },
    ],
    value: "acp-skills",
  },
} as const satisfies Record<string, MenuProps>;

// Internal id for the synthetic "pick an agent server" config option the UI
// injects into the command and config menus. This must never match a real
// ACP config option id: Claude Code's ACP adapter ships its own
// custom-agent/persona picker under the plain id "agent", which the filters
// below would otherwise mistake for this synthetic entry and hide from
// every surface. The synthetic option is UI-only — its id is never sent
// over the ACP wire (setConfigOption) or persisted as a last-used default;
// only the agent *server* the user picks is. See AGENT_CONFIG_OPTION_LABEL
// for the user-facing "agent" text (command title, typed /agent command,
// search keywords), which intentionally keeps the readable word and is
// unrelated to this sentinel.
export const AGENT_CONFIG_OPTION_ID = "__poolside-agent-server__";

// The synthetic agent-server picker's user-facing text: its command-menu
// title, the /agent typed command name, and its search keywords. Kept apart
// from AGENT_CONFIG_OPTION_ID (above) so a real agent's own "agent"-id
// option can never collide with our sentinel.
export const AGENT_CONFIG_OPTION_LABEL = "agent";

// True only for the synthetic agent-server picker injected by the UI, never
// for a real agent-supplied config option — even one that happens to use
// the plain id "agent" (as Claude Code's persona picker does).
export function isAgentPickerOptionId(optionId: string): boolean {
  return optionId === AGENT_CONFIG_OPTION_ID;
}

export function configMenuValue(optionId: string): string {
  return `acp-config:${optionId}`;
}
