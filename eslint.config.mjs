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
    }
);
