import { sveltekit } from "@sveltejs/kit/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { getTsconfig } from "get-tsconfig";
import { glob } from "glob";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageSync } from "read-pkg";
import { defineConfig, normalizePath } from "vite";
import { configDefaults } from "vitest/config";
import storybook from "./configs/storybook.js";
import { katexFonts } from "./katexFonts.js";
import { sharedWorkers } from "./sharedWorkers.js";
import { mergeConfigs } from "./utils/mergeConfigs.js";

export const base = defineConfig((_) => {
  const { config } = getTsconfig() ?? {};
  const isDom = config?.compilerOptions?.lib?.includes("dom");

  return {
    test: {
      globals: true,
      passWithNoTests: true,
      reporters: process.env["GITHUB_ACTIONS"]
        ? [...configDefaults.reporters, "github-actions"]
        : [...configDefaults.reporters, "verbose"],
      setupFiles: glob
        .sync("tests/**/*.setup.ts", {
          cwd: process.cwd(),
          absolute: true,
          nodir: true,
        })
        .map(normalizePath),
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            // Heavy Svelte integration suites (full component renders + debounced
            // effects on real timers) routinely exceed the 5s default on slower
            // CI runners. 20s keeps them green without per-test bumps everywhere.
            testTimeout: 20_000,
            include: ["src/**/*.test.ts"],
            exclude: [...configDefaults.exclude, "**/*.{browser,node}.test.ts"],
            typecheck: {
              include: ["src/**/*.test-d.ts"],
              enabled: true,
            },
            ...(isDom && {
              environment: "jsdom",
              setupFiles: normalizePath(
                resolve(dirname(fileURLToPath(import.meta.url)), "./dom.setup.js"),
              ),
            }),
          },
        },
        {
          extends: true,
          test: {
            name: { label: "node", color: "green" },
            include: ["**/*.node.test.ts"],
          },
        },
        {
          extends: true,
          test: {
            name: {
              label: "browser",
              color: "cyan",
            },
            environment: "happy-dom",
            include: ["**/*.browser.test.ts"],
          },
        },
      ],
    },
  };
});

export default defineConfig((env) => {
  const pkg = readPackageSync();
  const devDependencies = pkg.devDependencies ?? {};
  const peerDependencies = pkg.peerDependencies ?? {};

  function hasDependency(name: string) {
    return Object.hasOwn(devDependencies, name) || Object.hasOwn(peerDependencies, name);
  }

  let config = mergeConfigs(base(env), {
    plugins: [katexFonts(), sharedWorkers()],
    // Emit `?worker` imports (e.g. @pierre/diffs' highlight worker) as
    // module workers. Vite's default iife format is rejected by rollup for
    // code-splitting builds — any app with multiple HTML entries — and
    // every webview this workspace targets supports module workers.
    worker: {
      format: "es" as const,
    },
  });

  if (hasDependency("tailwindcss")) {
    config = mergeConfigs(config, {
      plugins: [tailwindcss()],
    });
  }

  if (hasDependency("@sveltejs/kit")) {
    config = mergeConfigs(config, {
      plugins: [sveltekit(), svelteTesting()],
    });
  } else if (hasDependency("svelte")) {
    config = mergeConfigs(config, {
      plugins: [svelte({ inspector: true }), svelteTesting()],
    });
  }

  if (
    process.env["CAMBER_SKIP_STORYBOOK_VITE"] !== "1" &&
    Object.hasOwn(devDependencies, "storybook")
  ) {
    config = mergeConfigs(config, storybook(env));
  }

  return config;
});

export { mergeConfigs };
