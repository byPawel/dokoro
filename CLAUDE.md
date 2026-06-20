# dokoro Guide

`dokoro` is a multi-layer **agent memory** MCP server (Working, Episodic, Semantic, Procedural, Affective memory). Built on the MCP TypeScript SDK, with SQLite (Drizzle ORM) + LanceDB vector storage and a file-backed workspace.

## Build & Test Commands

```sh
npm run build        # Build ESM + servers (CJS is built on prepack)
npm run lint         # Run ESLint over src/
npm test             # Fetch spec types, then run all tests
npx jest path/to/file.test.ts  # Run a specific test file
npx jest -t "test name"        # Run tests matching a pattern
npm run dev:core     # Run the core server in watch mode (also: dev:search, dev:planning, dev:analytics)
```

Before merge/release, run build, lint, and test unless the user narrows scope. For type-sensitive edits, rely on `npm run build` or `tsc --noEmit` — Jest alone will not catch type errors. For bug fixes, reproduce with a targeted Jest test when practical.

## Code Style Guidelines

- **TypeScript**: Strict type checking, ES modules, explicit return types
- **Naming**: PascalCase for classes/types, camelCase for functions/variables
- **Files**: Lowercase with hyphens, test files with `.test.ts` suffix
- **Imports**: ES module style, include `.js` extension, group imports logically
- **Error Handling**: Tools return `{ isError: true, content: [...] }` on failure rather than throwing across the MCP boundary
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
- **Testing**: Co-locate tests with source files; tests inject a DB handle via `globalThis.__TEST_DB__`
- **Comments**: JSDoc for public APIs, inline comments for complex logic

## Agent Operating Rules

- Implement the simplest solution to the asked problem; no speculative abstractions. Push back on overcomplicated requests.
- Touch only lines the task requires; match existing style.
- Never claim a build/test/release passed unless you ran it and have the output; report blockers directly.
- Confirm active worktree/branch before editing when multiple sessions or worktrees are in play.
- Use the GitHub noreply email for commits.
- Split long subagent/council jobs into smaller batches; spawn agents only when they materially improve the result.

## Project Structure

- `/src/servers`: MCP server entrypoints (core, search, planning, analytics, unified)
- `/src/tools`: Tool implementations, grouped by memory layer (workspace, session, entity, plan, feedback)
- `/src/db`: SQLite schema, migrations, and Drizzle models
- `/src/services`: Entity extraction (regex + Ollama LLM), embeddings, vector indexing
- `/src/utils`, `/src/types`, `/src/shared`: Helpers, type definitions, shared constants
- Tests live alongside source as `*.test.ts`
- Node.js >= 22 required

## Tools by memory layer

- **Working**: `dokoro_workspace_*`, `dokoro_session_log`, `dokoro_question_*`, `dokoro_file_claim`, `dokoro_file_release`, `dokoro_claim_list`
- **Episodic**: `dokoro_session_recall`, `dokoro_compress_week`
- **Semantic**: `dokoro_entity_graph` (bi-temporal `as_of`), `dokoro_entity_extract_deep`
- **Procedural**: `dokoro_plan_*`
- **Affective**: `dokoro_feedback_record`, `dokoro_feedback_query`
- **Lifecycle**: `dokoro_archive_sweep` (manual sweep; `dokoro_plan_validate` auto-archives validated plans, `dokoro_workspace_claim` sweeps opportunistically)
