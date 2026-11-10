import type { MenuProps } from "@camber/components/prompt";

export const menus = {
  command: {
    rules: [
      {
        trigger: "/",
        triggerRegExp: /^\/(?!\s)/g,
        queryRegExp: /^\S*$/,
      },
    ],
    filterOptions: {
      strictTitleMatching: true,
    },
    value: "command",
  },
  devtools: {
    value: "devtools",
  },
  sandbox: {
    value: "sandbox",
    rules: [
      {
        trigger: "/",
        triggerRegExp: /^\/(?!\s)/g,
        queryRegExp: /^\S*$/,
      },
    ],
  },
  secrets: {
    value: "secrets",
  },
  approvals: {
    value: "approvals",
    rules: [
      {
        trigger: "/",
        triggerRegExp: /^\/(?!\s)/g,
        queryRegExp: /^\S*$/,
      },
    ],
  },
  skills: {
    value: "skills",
    rules: [
      {
        trigger: "/",
        triggerRegExp: /^\/(?!\s)/g,
        queryRegExp: /^\S*$/,
      },
    ],
  },
  files: {
    value: "files",
    rules: [
      {
        trigger: "@",
        triggerRegExp: /(?<=\s|^)@(?!\s|https?:\/\/)/g,
        // Either a non-whitespace token, or a `"..."`-quoted string so paths
        // with spaces (e.g. `@"~/Pic Folder/cv.pdf"`) keep the menu open.
        queryRegExp: /^"[^"]*"?$|^\S*$/,
      },
    ],
    shouldFilter: false,
  },
  websites: {
    value: "websites",
    rules: [
      {
        trigger: "@",
        triggerRegExp: /(?<=\s|^)@(?!\s)/g,
        queryRegExp: /^(https?:\/\/)?(?:www\.)?([^\/\s]*)?(\/\S*)?$/,
      },
    ],
    shouldFilter: false,
    highlightMatch: false,
  },
  symbols: {
    value: "symbols",
    rules: [
      {
        trigger: "#",
        triggerRegExp: /(?<=\s|^)#(?=\S*$)/g,
        queryRegExp: /^\S*$/,
      },
    ],
  },
  enrichment: {
    value: "enrichment",
    filterOptions: {
      strictTitleMatching: true,
    },
  },
  mcp: {
    value: "mcp",
  },
  "mcp-server": {
    value: "mcp-server",
  },
  "secret-edit": {
    value: "secret-edit",
  },
} as const satisfies Record<string, MenuProps>;
