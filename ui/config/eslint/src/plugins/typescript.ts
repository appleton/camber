import ts, { type ConfigArray } from "typescript-eslint";

const restrictedLodashMemoizeMessage =
  "lodash memoize can create unbounded caches and leak memory. Use an explicitly bounded cache.";
const restrictedUnscopedLodashMessage =
  'Avoid unscoped lodash imports. Import specific functions instead, e.g. import { isEqual } from "lodash".';

const noRestrictedLodashMemoize: [
  "error",
  {
    paths: Array<{
      name: string;
      message: string;
      importNames?: string[];
    }>;
  },
] = [
  "error",
  {
    paths: [
      {
        name: "lodash/memoize",
        message: restrictedLodashMemoizeMessage,
      },
      {
        name: "lodash.memoize",
        message: restrictedLodashMemoizeMessage,
      },
      {
        name: "lodash",
        importNames: ["memoize"],
        message: restrictedLodashMemoizeMessage,
      },
    ],
  },
];

const noRestrictedUnscopedLodash: [
  "error",
  {
    selector: string;
    message: string;
  },
  {
    selector: string;
    message: string;
  },
] = [
  "error",
  {
    selector: 'ImportDeclaration[source.value="lodash"] > ImportDefaultSpecifier',
    message: restrictedUnscopedLodashMessage,
  },
  {
    selector: 'ImportDeclaration[source.value="lodash"] > ImportNamespaceSpecifier',
    message: restrictedUnscopedLodashMessage,
  },
];

const config: ConfigArray = ts.config(
  {
    name: "javascript/camber",
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "no-lonely-if": "warn",
      "prefer-const": "warn",
      "no-restricted-imports": noRestrictedLodashMemoize,
      "no-restricted-syntax": noRestrictedUnscopedLodash,
    },
  },
  {
    name: "typescript-eslint/project-service",
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      "@typescript-eslint": ts.plugin,
    },
    rules: {
      "no-lonely-if": "warn",
      "prefer-const": "warn",
      "no-restricted-imports": noRestrictedLodashMemoize,
      "no-restricted-syntax": noRestrictedUnscopedLodash,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);

export default config;
