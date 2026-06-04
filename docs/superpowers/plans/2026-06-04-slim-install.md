# Slim the install footprint (~303MB node_modules)

Date: 2026-06-04
Status: Landed (LanceDB optionalization). Ink/React TUI optionalization: DEFERRED.

## Goal

Reduce the INSTALL footprint of `dokoro` without breaking functionality. The
`node_modules` tree is ~303MB, dominated by the native vector stack.

## Measured footprint (this machine, `du -sh`)

| Package               | Size   | Disposition           |
| --------------------- | ------ | --------------------- |
| `@lancedb/lancedb`    | ~94 MB | moved to optional     |
| `apache-arrow`        | ~9.8 MB| moved to optional     |
| `ink`                 | ~1.8 MB| DEFERRED (kept)       |
| `react`               | ~252 KB| DEFERRED (kept)       |
| `ink-gradient`        | ~132 KB| DEFERRED (kept)       |
| `gradient-string`     | ~28 KB | DEFERRED (kept)       |

Optionalizing the vector stack removes ~104 MB from a default install for users
who do not run semantic vector search (the core memory server does not need it
to start). The entire ink/react TUI stack is only ~2.2 MB combined — a poor
risk/reward for the refactor it would require (see "Deferred" below).

## What landed

### 1. Split the embedding/chunking surface out of the LanceDB module

`src/services/vector-service.ts` previously imported `@lancedb/lancedb` at the
top level, so *any* importer (including the core server, via
`EmbeddingService`) loaded the 94 MB native module at startup.

- Created `src/services/embedding-service.ts` containing `EmbeddingService`,
  `ChunkingService`, and the `EmbeddingResult` / `Chunk` types. This module has
  **no** dependency on `@lancedb/lancedb`.
- `vector-service.ts` now re-exports `EmbeddingService`, `ChunkingService`,
  `EmbeddingResult`, and `Chunk` from `embedding-service.ts` for backward
  compatibility, so existing importers of `./vector-service.js` keep working.
- `src/tools/workspace-tools.ts` (the core server's embedding consumer) now
  imports `EmbeddingService` from `embedding-service.ts` directly — it never
  pulls in the LanceDB module boundary.

### 2. Lazy-load `@lancedb/lancedb` inside `VectorStoreService`

- Removed the top-level `import * as lancedb from '@lancedb/lancedb'`.
- Added `import type * as LanceDB from '@lancedb/lancedb'` for type-only usage
  (carries no runtime require).
- `VectorStoreService` fields are typed `LanceDB.Connection | null` /
  `LanceDB.Table | null`.
- A private `_loadLancedb()` performs `await import('@lancedb/lancedb')` lazily.
  The string literal is used directly so module resolution/bundlers can still
  locate it when the dep IS present.
- `init()` calls `_loadLancedb()` and uses the resolved module for `connect()`.

### 3. Descriptive error when the optional dep is missing

`_loadLancedb()` wraps the dynamic import in try/catch and throws:

```
LanceDB is not installed. Run: npm install @lancedb/lancedb apache-arrow
```

(The underlying module-not-found message is appended in parentheses for
diagnostics.) Note: `Error`'s `cause` option is NOT used because the build
targets `es2018`, where the two-argument `Error` constructor is not in the lib
types; appending the detail to the message keeps the es2018 build green.

### 4. package.json

Moved `@lancedb/lancedb` (`^0.23.0`) and `apache-arrow` (`^18.1.0`) from
`dependencies` to a new `optionalDependencies` block, same version specifiers.
`apache-arrow` has no direct import in `src/` (verified); it is a transitive
dep of LanceDB and is listed alongside it so the install hint is complete.
`npm install` regenerated `package-lock.json` accordingly.

## Tests

- `src/services/embedding-service.test.ts` — constructability of the new module.
- `src/services/chunking.test.ts` and `src/services/embedding-timeout.test.ts`
  re-pointed from `./vector-service.js` to `./embedding-service.js` (the logic is
  unchanged; they no longer transitively need LanceDB).
- `src/tools/workspace-tools.{summary,recall,compaction}.test.ts` — the offline
  `EmbeddingService` mock target moved from `../services/vector-service.js` to
  `../services/embedding-service.js`, matching the new import site in
  `workspace-tools.ts`.
- `src/services/vector-store-lazy.test.ts` — virtually mocks `@lancedb/lancedb`
  as not-installed and asserts (a) `embedding-service` instantiates without
  triggering it, and (b) `VectorStoreService.init()` throws the install-hint
  error. Uses a `{ virtual: true }` jest mock so ts-jest never tries to
  transform the native `.node` binding.

Final state: `npm run build`, `npm test` (181 tests, was 176 + 5 new), and
`npm run lint` all green.

## Deferred: ink / react / ink-gradient / gradient-string TUI rendering

The ink/react TUI rendering (`src/utils/render-output.tsx`,
`src/utils/ink-renderer.tsx`) is **NOT** optionalized in this change.

Justification:

1. `renderOutput()` is called **synchronously** inside ~14 tool-handler bodies.
   Making the ink stack lazy-importable would require those handlers to become
   `async`-returning-`Promise` — a broad, mechanical refactor of the tool layer.
2. Every test mocks `renderOutput` (e.g.
   `jest.mock('../utils/render-output.js', ...)`), so a broken ink load at
   runtime would be **invisible** to the suite. There is no test coverage of the
   actual ink rendering path, so a silent-downgrade-to-plain-text fallback could
   strip formatting for existing users with zero test signal.
3. The whole ink/react/gradient stack is only ~2.2 MB on disk — removing it from
   a default install yields a tiny saving relative to the ~104 MB from LanceDB,
   at meaningfully higher regression risk.

Revisit only under a dedicated initiative that: adds a `--no-tui` install flag
(or env switch), ships a plain-text fallback renderer, and adds tests that
exercise the fallback path so the downgrade is observable.
