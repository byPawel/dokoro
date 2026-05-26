# devlog-mcp Guide

`devlog-mcp` is a multi-layer **agent memory** MCP server (Working, Episodic, Semantic, Procedural, Affective memory). Built on Anthropic's MCP TypeScript SDK, with SQLite (Drizzle ORM) + LanceDB vector storage and a file-backed workspace.

## Build & Test Commands

```sh
npm run build        # Build ESM + servers (CJS is built on prepack)
npm run lint         # Run ESLint over src/
npm test             # Fetch spec types, then run all tests
npx jest path/to/file.test.ts  # Run a specific test file
npx jest -t "test name"        # Run tests matching a pattern
npm run dev:core     # Run the core server in watch mode (also: dev:search, dev:planning, dev:analytics)
```

## Code Style Guidelines

- **TypeScript**: Strict type checking, ES modules, explicit return types
- **Naming**: PascalCase for classes/types, camelCase for functions/variables
- **Files**: Lowercase with hyphens, test files with `.test.ts` suffix
- **Imports**: ES module style, include `.js` extension, group imports logically
- **Error Handling**: Tools return `{ isError: true, content: [...] }` on failure rather than throwing across the MCP boundary
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
- **Testing**: Co-locate tests with source files; tests inject a DB handle via `globalThis.__TEST_DB__`
- **Comments**: JSDoc for public APIs, inline comments for complex logic

## Project Structure

- `/src/servers`: MCP server entrypoints (core, search, planning, analytics, unified)
- `/src/tools`: Tool implementations, grouped by memory layer (workspace, session, entity, plan, feedback)
- `/src/db`: SQLite schema, migrations, and Drizzle models
- `/src/services`: Entity extraction (regex + Ollama LLM), embeddings, vector indexing
- `/src/utils`, `/src/types`, `/src/shared`: Helpers, type definitions, shared constants
- Tests live alongside source as `*.test.ts`
- Node.js >= 18 required

## Tools by memory layer

- **Working**: `devlog_workspace_*`, `devlog_session_log`, `devlog_question_*`
- **Episodic**: `devlog_session_recall`, `devlog_compress_week`
- **Semantic**: `devlog_entity_graph` (bi-temporal `as_of`), `devlog_entity_extract_deep`
- **Procedural**: `devlog_plan_*`
- **Affective**: `devlog_feedback_record`, `devlog_feedback_query`
