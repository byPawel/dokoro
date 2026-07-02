import { createDefaultEsmPreset } from "ts-jest";

const esmPreset = createDefaultEsmPreset();

// Shared transform/resolution. ts-jest emits ESM syntax; whether jest EXECUTES a
// file as ESM or CJS is decided per project by `extensionsToTreatAsEsm`.
const shared = {
  ...esmPreset,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^pkce-challenge$": "<rootDir>/src/__mocks__/pkce-challenge.ts"
  },
  transformIgnorePatterns: [
    "/node_modules/(?!eventsource)/"
  ],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/\\.claude/"],
  // Keep jest-haste-map from crawling git worktrees under .claude/, which would
  // otherwise collide on duplicate manual mocks (pkce-challenge) and haste module
  // names (dokoro).
  modulePathIgnorePatterns: ["<rootDir>/\\.claude/"],
};

/**
 * Two projects because the codebase mixes module systems under one jest run:
 *  - `cjs` runs the .test.ts suites, which use the deferred `require('./x.js')`
 *    load pattern (CJS) — the bulk of the tests.
 *  - `esm` runs the .test.tsx TUI smoke tests. browse-ui pulls in ink@6 (pure
 *    ESM with a top-level await in yoga-layout's wasm loader) and db/index.ts
 *    (`import.meta.url`); both need native ESM, so this project treats the whole
 *    .ts/.tsx graph as ESM. Requires `--experimental-vm-modules` (set in the
 *    `test` npm script).
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
export default {
  projects: [
    {
      ...shared,
      displayName: "cjs",
      testMatch: ["<rootDir>/src/**/*.test.ts"],
      // The ESM preset defaults extensionsToTreatAsEsm to ['.ts','.tsx','.mts'].
      // Force it empty so every .ts here loads as CJS — these suites use the
      // deferred `require('./x.js')` load pattern, which needs a CJS module.
      extensionsToTreatAsEsm: [],
    },
    {
      ...shared,
      displayName: "esm",
      testMatch: ["<rootDir>/src/**/*.test.tsx"],
      extensionsToTreatAsEsm: [".ts", ".tsx"],
    },
  ],
};
