// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ["dist/**", "node_modules/**", "coverage/**", ".claude/**", "*.config.js", "*.config.mjs", "*.config.cjs"],
    },
    {
        languageOptions: {
            globals: {
                console: "readonly",
                process: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                Buffer: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
                exports: "readonly",
                module: "readonly",
                require: "readonly",
                global: "readonly",
                URL: "readonly",
                URLSearchParams: "readonly",
                fetch: "readonly",
                Headers: "readonly",
                Response: "readonly",
                Request: "readonly",
                AbortController: "readonly",
                btoa: "readonly",
                atob: "readonly"
            }
        },
        linterOptions: {
            reportUnusedDisableDirectives: false,
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
        }
    },
    {
        files: ["src/client/**/*.ts", "src/server/**/*.ts"],
        ignores: ["**/*.test.ts"],
        rules: {
            "no-console": "off"
        }
    },
    {
        // Standalone devlog server entrypoints cast Zod tool schemas and handler
        // args to `any` as an intentional workaround for the MCP SDK's tool()
        // overload typings. Inline disable directives proved fragile across
        // reformatting (the de-vendor refactor split the object literals and
        // stranded the disables above the `{`, breaking CI lint). Allow explicit
        // any in just these two files instead.
        files: ["src/dokoro-server.ts", "src/dokoro-http-server.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off"
        }
    }
);
