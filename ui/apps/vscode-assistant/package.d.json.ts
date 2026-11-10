/**
 * Generated file.
 * Do not edit manually.
 */
declare const packageJson: {
  name: "camber-assistant";
  displayName: "Camber Assistant";
  version: "0.0.0";
  private: true;
  description: "The power of Camber, right in your editor";
  categories: ["Machine Learning"];
  keywords: ["ai", "chat"];
  license: "Apache-2.0";
  qna: "https://github.com/appleton/camber/discussions";
  author: {
    name: "Andy Appleton";
    url: "https://github.com/appleton";
  };
  publisher: "appleton";
  type: "module";
  main: "./dist/extension/main.cjs";
  scripts: {
    build: "vite build";
    "build-debug-vsix": "bash scripts/build-vsix-for-debug.sh";
    "check:format": "prettier . --check --cache --ignore-path ../../.gitignore";
    "check:lint": "eslint --no-error-on-unmatched-pattern './src/**/*.{js,mjs,cjs,ts,tsx,svelte}' './scripts/**/*.{js,mjs,cjs,ts,tsx,svelte}'";
    "check:release-build": "node scripts/check-release-build.mjs";
    "check:types": 'svelte-check --tsconfig tsconfig.check.json --fail-on-warnings --compiler-warnings "state_referenced_locally:ignore,a11y_no_static_element_interactions:ignore"';
    "codegen:types": "tsx scripts/generate-package-json-dts.ts";
    dev: "vite";
    "download:binaries": "bash scripts/copy_helper.sh";
    "fix:format": "prettier . --write --cache --ignore-path ../../.gitignore --list-different";
    "fix:lint": "eslint --no-error-on-unmatched-pattern './src/**/*.{js,mjs,cjs,ts,tsx,svelte}' './scripts/**/*.{js,mjs,cjs,ts,tsx,svelte}' --fix";
    "generate:icons": "fantasticon";
    "make-release-manifest": "tsx scripts/make-release-manifest.ts";
    package: "vsce package --no-dependencies --allow-missing-repository";
    prepare: "turbo codegen:types --output-logs errors-only";
    preview: "vite preview";
    publish: "vsce publish --allow-all-proposed-apis";
    test: "vitest run";
    "test:unit": "vitest run --project unit";
    "test:unit:watch": "vitest --project unit";
    "test:watch": "vitest";
  };
  contributes: {
    commands: [
      {
        category: "Camber";
        command: "camber.focusInput";
        icon: "$(camber-roundel)";
        title: "Focus on Prompt Input";
      },
      {
        category: "Camber";
        command: "camber.togglePlanMode";
        title: "Toggle Plan Mode";
      },
      {
        category: "Camber";
        command: "camber.newConversation";
        title: "New Conversation";
        icon: "$(camber-new)";
      },
      {
        category: "Camber";
        command: "camber.resetConfiguration";
        title: "Reset Configuration";
      },
      {
        category: "Camber";
        command: "camber.showSidebar";
        title: "Show Sidebar";
      },
      {
        category: "Camber";
        command: "camber.openPermissionSettings";
        title: "Open Permissions Settings";
      },
      {
        category: "Camber";
        command: "camber.openSettings";
        title: "Extension Settings";
        icon: "$(camber-settings)";
      },
    ];
    configuration: {
      title: "camber";
      properties: {
        "camber.showKeybindings": {
          default: true;
          description: "Show keybinding hints in the Camber UI";
          type: "boolean";
        };
        "camber.wrapLines": {
          default: true;
          description: "Wrap lines in code snippets";
          type: "boolean";
        };
        "camber.codeFontSize": {
          default: 0;
          description: "Font size for code snippets in pixels. Use 0 to inherit from editor font size";
          type: "number";
          minimum: 0;
          maximum: 72;
        };
        "camber.showMermaidDiagrams": {
          default: false;
          markdownDescription: "`Experimental` Visualise Mermaid diagrams in code blocks";
          type: "boolean";
        };
        "camber.notifyOnApproval": {
          default: true;
          description: "Show a system notification when approval is needed and the window is not focused";
          type: "boolean";
        };
        "camber.toolActivity": {
          default: "grouped";
          description: "How much detail to show while the agent works. Finished replies always collapse into a summary.";
          type: "string";
          enum: ["detailed", "grouped", "compact"];
          enumItemLabels: ["Detailed", "Grouped", "Compact"];
          enumDescriptions: [
            "Every step, as it happens — all tool calls stay visible while the agent responds",
            "Tool calls fold into short summaries, leaving the agent's messages between them",
            "One summary line plus the current step — tool calls and interim messages fold as the agent works",
          ];
        };
        "camber.defaultWorkingDirectory": {
          default: "";
          description: "Working directory the assistant uses when no folder is open in VS Code. Leave empty to use a scratch directory (~/.poolside/scratch, or %LOCALAPPDATA%\\camber\\scratch on Windows) so the agent's file tools start there instead of at your home directory.";
          type: "string";
        };
        "camber.agentServers": {
          default: {};
          markdownDescription: "Named ACP servers available to the Camber ACP client. The Camber server is available as `default` from the ACP registry unless that entry is configured here. Each entry requires `command`; optional `args`, `env`, and `default_config_options` are passed to that server.";
          type: "object";
          additionalProperties: {
            type: "object";
            required: ["command"];
            properties: {
              command: {
                type: "string";
                description: "Executable name or path.";
              };
              args: {
                type: "array";
                items: {
                  type: "string";
                };
                description: "Arguments appended to the command.";
              };
              env: {
                type: "object";
                additionalProperties: {
                  type: "string";
                };
                description: "Additional environment variables for the server process.";
              };
              default_config_options: {
                type: "object";
                additionalProperties: {
                  type: "string";
                };
                description: "Session config options to apply immediately after session creation.";
              };
            };
          };
        };
      };
    };
    icons: {
      "camber-roundel": {
        description: "Roundel to use in the status bar";
        default: {
          fontPath: "./dist/resources/font/camber.woff";
          fontCharacter: "";
        };
      };
      "camber-settings": {
        description: "Icon to use for settings";
        default: {
          fontPath: "./dist/resources/font/camber.woff";
          fontCharacter: "";
        };
      };
      "camber-new": {
        description: "Icon to use for new conversations";
        default: {
          fontPath: "./dist/resources/font/camber.woff";
          fontCharacter: "";
        };
      };
    };
    keybindings: [
      {
        command: "camber.showSidebar";
        key: "ctrl+escape";
        mac: "cmd+escape";
      },
      {
        command: "camber.togglePlanMode";
        key: "shift+tab";
        when: "camber.webviewFocus";
      },
    ];
    languages: [
      {
        id: "markdown";
        extensions: [".camber", ".poolside"];
      },
    ];
    menus: {
      "editor/title": [
        {
          command: "camber.focusInput";
          group: "navigation@1";
        },
      ];
      "view/title": [
        {
          command: "camber.newConversation";
          when: "view == camber-webview";
          group: "navigation@1";
        },
      ];
    };
    views: {
      camber: [
        {
          id: "camber-webview";
          name: "Camber";
          type: "webview";
          webview: "camber-webview";
          visibility: "visible";
        },
      ];
    };
    viewsContainers: {
      activitybar: [
        {
          id: "camber";
          title: "Camber";
          icon: "./dist/resources/icon-light.svg";
        },
      ];
    };
    yamlValidation: [
      {
        fileMatch: "**/{.,}camber/settings{.local,}.{yaml,yml}";
        url: "./dist/resources/camber.settings.json";
      },
    ];
  };
  activationEvents: ["onStartupFinished"];
  "lint-staged": {
    "*": ["prettier --ignore-unknown --write"];
  };
  dependencies: {
    "@camber/assistant": "workspace:*";
    "@camber/features": "workspace:*";
    "@camber/helperapi": "workspace:*";
    "@camber/lib": "workspace:*";
    "@camber/rpc": "workspace:*";
    "@estruyf/vscode": "^1.1.0";
    "@mozilla/readability": "^0.5.0";
    archiver: "^7.0.0";
    chokidar: "^4.0.3";
    "comment-json": "^4.2.5";
    json5: "^2.2.3";
    linkedom: "^0.16.8";
    lodash: "catalog:";
    luxon: "catalog:";
    "serialize-error": "^11.0.3";
    "vscode-diff": "^2.1.1";
    "vscode-languageclient": "^9.0.1";
  };
  devDependencies: {
    "@camber/eslint-config": "workspace:*";
    "@camber/prettier-config": "workspace:*";
    "@camber/svelte-config": "workspace:*";
    "@camber/tailwind-config": "workspace:*";
    "@camber/tsconfig": "workspace:*";
    "@camber/vite-config": "workspace:*";
    "@types/archiver": "^6.0.0";
    "@types/lodash": "catalog:";
    "@types/luxon": "catalog:";
    "@types/node": "catalog:";
    "@types/vscode": "^1.85.0";
    "@types/vscode-webview": "^1.57.5";
    "@vscode/vsce": "^3.4.2";
    eslint: "catalog:";
    execa: "catalog:";
    fantasticon: "^3.0.0";
    "jest-mock-vscode": "^4.6.0";
    prettier: "catalog:";
    svelte: "catalog:";
    "svelte-check": "catalog:";
    tailwindcss: "catalog:";
    tsdown: "catalog:";
    tsx: "catalog:";
    "type-fest": "catalog:";
    typescript: "catalog:";
    vite: "catalog:";
    vitest: "catalog:";
  };
  engines: {
    vscode: "^1.85.0";
  };
  icon: "./dist/resources/icon.png";
  galleryBanner: {
    color: "#FFFAF5";
    theme: "light";
  };
  preview: false;
};

export default packageJson;
