import { createDefaultEsmPreset } from "ts-jest";

const defaultEsmPreset = createDefaultEsmPreset();

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  ...defaultEsmPreset,
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
  // names (@devlog-mcp/core).
  modulePathIgnorePatterns: ["<rootDir>/\\.claude/"],
};
