# Dokoro SOLID Audit → Refactor Plan

> **Date:** 2026-06-10
> **Method:** 6 parallel read-only auditors, one per layer (servers, tools A/B, services, db, cross-cutting), each applying the same SOLID rubric with `file:line` evidence. All load-bearing claims independently re-verified by grep against the source before this plan was written.
> **Scope:** `src/` — ~24,700 LOC across 98 non-test TypeScript files.

---

## Verified findings

Every load-bearing claim below was checked against the actual source, not taken on an agent's word:

| Claim | Verified |
|---|---|
| Concrete DB reached directly outside `src/db` | **27** `getSqliteDb` refs across **12 files** (tools, utils, servers, services) |
| Raw SQL leaked into app layer | **79** `.prepare()` calls outside `src/db` |
| `dokoro-db-tools.ts` (693 LOC) is dead | **0 importers** — orphan with a divergent `ToolDefinition` type |
| `dokoro_tag_stats` registered twice | Defined in **both** `ai-tagging-tools.ts:197` and `tag-tools.ts:51` — runtime collision, last-load silently wins |
| `config/tool-config.ts` is dead | **0 importers** |
| Legacy `dokoro-server.ts` / `dokoro-http-server.ts` | Not in `package.json`/`bin` — **~600 LOC dead weight** |
| `EmbeddingCache` never engaged in prod | All 4 `new EmbeddingService()` calls pass **no cache arg** — cache is dead infrastructure |
| Config scattered | **34** `process.env` reads + a module-load-time `DOKORO_PATH` global |

---

## Verdict

Dokoro is **architecturally healthy at the edges, weak at the core.** The *outer* seam (tools-as-data + `registry.ts` + the `withToolTracking` decorator) is genuinely good OCP. But there are **no abstractions in the middle** — every layer reaches straight through to concrete SQLite, concrete Ollama, and a global filesystem path. The consequence: **DIP is failing system-wide (1–2/5 everywhere)**, which is what makes the code hard to test, hard to extend, and prone to the duplication seen throughout.

### Scorecard heatmap (1 = poor, 5 = excellent)

| Layer | SRP | OCP | LSP | ISP | **DIP** |
|---|:--:|:--:|:--:|:--:|:--:|
| Servers & entry | 2 | 3 | 4 | 3 | **2** |
| Tools A (state/tracking) | 2 | 4 | 3 | 4 | **1** |
| Tools B (AI/analysis) | 2 | 2 | 3 | 3 | **2** |
| Services | 2 | 2 | 3 | 4 | **2** |
| DB / persistence | **1** | 2 | – | 2 | **1** |
| Cross-cutting | 3 | 3 | 2 | 3 | **1** |

The column that matters is the last one. **Fix DIP and most of the others follow.**

---

## The 4 root causes (everything else is a symptom)

1. **No ports/interfaces exist.** The one behavioral interface in the whole cross-cutting layer (`ToolConfig`) is dead code. There is no `DbRepository`, no `EmbeddingProvider`, no `Config` port. Every consumer depends on a concretion. → drives the 27 DB leaks, 79 raw-SQL sites, hardcoded Ollama, and the `globalThis.__TEST_DB__` test hack (which exists *only because* there's no injection seam).

2. **God objects.** `db/index.ts` (867 LOC: connection + schema + vector DDL + migrations + CRUD for 5 aggregates), `entity-extractor.ts` (766 LOC: 3 classes in one file), the `workspace_dump` handler (~225 LOC), `dokoro-cli.ts` (567 LOC). One file = many reasons to change.

3. **Missing shared abstractions → copy-paste.** `feature-tracking` and `issue-tracking` are ~90% clones; a YAML frontmatter parser is hand-rolled 3× (and drifts — `issue` parses `## 🔧 Solution` but writes `## Solution`, so it never round-trips); a `db()` helper is pasted into 6 files; a keyword classifier is reinvented 5×.

4. **Dead / divergent code.** ~1,300+ LOC reachable by nobody (orphan db-tools, dead config, legacy servers, unwired cache, ad-hoc `test-*.ts` scripts in `src/tools/`), plus a live tool-name collision.

---

## Target architecture (the "to-be")

```
composition root (server bootstrap / CLI)  ← the ONLY place that does `new`
        │ injects
        ▼
  ports (interfaces)  ──  src/shared/ports/ + src/config/
   DokoroConfig · DbContext · {Doc,Entity,Feedback,...}Repository
   EmbeddingProvider · InferenceProvider · VectorStorePort
        ▲                    ▲                    ▲
   tools depend on      services depend on   db implements
   interfaces           interfaces           repositories
```

**Rule:** tools and services receive abstractions; only the composition root knows the concrete SQLite/Ollama/LanceDB.

---

## The plan — 6 phases, ordered by leverage × dependency

> **Strategy: strangler, not big-bang.** There's a working test suite and a shipping product. Each phase keeps the build green; do **Phase 0's characterization tests first** so behavior is pinned before any code moves. A literal "rewrite" is the wrong move — incrementally invert dependencies behind the seams.

### Phase 0 — Stop the bleeding (low risk, ~1–2 days)
Pure deletions and a safety net. No behavior change.
- **Delete dead code:** `config/tool-config.ts`, `dokoro-server.ts`, `dokoro-http-server.ts`, and either delete or port `dokoro-db-tools.ts` (693 LOC orphan). Move `tools/test-{similarity,smart-tagger,summarization}.ts` to `scripts/`.
- **Fix the live bug:** the duplicate `dokoro_tag_stats` registration (rename one to `dokoro_tag_stats_taxonomy`).
- **Net the behavior:** add characterization tests around the public MCP tool surface (input → output) for the tools refactored in Phases 3–4. This is the refactor insurance.
- **Payoff:** −~1,300 LOC, one latent crash fixed, safe ground for everything below.

### Phase 1 — Define the seams (the DIP foundation) — *highest leverage*
Create the interfaces; don't rewire callers yet.
- `src/config/`: `DokoroConfig` interface + `createConfig(env)` factory. Collapse the `DOKORO_PATH` global and the 34 `process.env` reads behind it.
- `src/db/repositories/`: per-aggregate interfaces — `DocRepository`, `EntityRepository`, `FeedbackRepository`, `SharedBlocksRepository`, `HandoffRepository`, `PresenceRepository`, etc. + a single `DbContext` / `getProjectDb()`.
- `src/shared/ports/`: `EmbeddingProvider`, `InferenceProvider`, `VectorStorePort` (the one good model already exists — `MermaidMCPClient` in `mermaid-integration.ts` — replicate it).
- **Payoff:** establishes *where abstractions live*. Unblocks all of Phase 2.

### Phase 2 — Route everything through the seams (DIP enforcement)
Move the concrete dependencies behind the Phase-1 interfaces, aggregate by aggregate.
- Pull the **79 raw `.prepare()`** blocks into repository methods named for the domain op (`feedbackRepo.recordOutcome()`), so SQL lives only in `src/db`.
- Replace the **27 `getSqliteDb()`** direct calls + the copy-pasted `db()` helper + `globalThis.__TEST_DB__` with injected repos.
- Replace `new EmbeddingService()` / Ollama `fetch` with injected `EmbeddingProvider` / `InferenceProvider`; **wire `EmbeddingCache`** (currently dead) through `createVectorServices`.
- Make `createVectorServices` + server `startServer` the **composition root** that does the wiring; give `startServer`/CLI an injectable `{ db, compactionService }`.
- **Payoff:** DIP 1→4 across the board; the codebase becomes unit-testable without real SQLite/Ollama; kills the test hack.

### Phase 3 — Decompose the god objects (SRP)
Now safe, because dependencies are injected and behavior is pinned.
- `db/index.ts` → `connection.ts` + `bootstrap.ts` + the Phase-2 repository modules; **delete the divergent `createTablesManually` fallback** (3rd source of schema truth).
- `entity-extractor.ts` → `entity-extractor.ts` + `relation-detector.ts` + `entity-persistence.ts` (the file is already banner-sectioned — clean cut lines).
- `IndexingService.indexDocument` → coordinator + `ChunkRepository`.
- `dokoro-cli.ts` → table-driven command registry, one module per command.
- Rename `db/migrate.ts` → `import-markdown.ts`, move to ingestion layer (it's an importer, not a migrator — confusing name collision with `migrations.ts`).

### Phase 4 — Extract shared abstractions (DRY / SRP)
- **`MarkdownTrackerStore<TEntity>`** parameterized by `{ statusDirs, frontmatterSchema, template }` → collapse `feature/issue/task/weekly/backup` tracking onto it (~700 LOC saved, fixes the `## Solution` round-trip bug).
- Shared **frontmatter parser** on `gray-matter` (already a dep) replacing the 3 hand-rolled copies.
- Shared **corpus reader** (`globDokoro` + `readFrontmatter` + `normalizeTags` + `filterByDate`) for the AI/analysis tools.
- **`withErrorCard(handler)`** wrapper (mirror `withToolTracking`) to kill the dozens of try/catch + status-card boilerplate blocks.
- Unify the 5 keyword classifiers into one `ContentClassifier`.

### Phase 5 — Open the algorithm hotspots (OCP)
- Strategy registries for the hardcoded `switch`/`if-else` variant selectors: `FormatStrategy` (summary styles), `SimilarityMetric` (the 0.7/0.2/0.1 weights), `GraphRenderer` (mermaid/dot/json), `EntityExtractorStrategy[]`.
- Table-driven `cli-detector` / `detectWorkType`.
- Remove or implement the stub scorers (`calculateHandoffEfficiency` returns hardcoded `0.85`; `calculateTagFrequency` is a static table commented "in a real implementation…").

---

## Sequencing & risk

- **Hard dependency:** Phase 1 → Phase 2 → Phase 3. You cannot safely split the god objects (3) until dependencies are injected (1–2) and behavior is pinned (0).
- **Independent / parallelizable:** Phases 4 and 5 can proceed per-module once Phase 2 is done; assign them to separate workstreams.
- **Don't break what's good:** keep the `registry.ts` tools-as-data pattern, the `withToolTracking` decorator, the lazy-load seams in `vector-service`, and the pure utils (`vector-math`, `text-processor`, `tag-taxonomy`). These are templates, not targets.
- **Biggest single win:** Phase 1+2 on the DB seam alone fixes the worst violation in 4 of 6 layers.

---

## Appendix — per-layer highlights

**Servers & entry:** good shared factory (`base-server.ts`) and thin composition roots, but two legacy entry points duplicate search logic 3×, `dokoro-cli.ts` is a 567-LOC god file, and `startServer` mixes register/connect/recovery. No injection seam for db/compaction.

**Tools A (state/tracking):** excellent data-driven registration (OCP), but `db()` + `globalThis.__TEST_DB__` pasted across 6 files, `feature`/`issue` tracking are 90% clones, frontmatter parser triplicated, `dokoro-db-tools.ts` is a 693-LOC unregistered orphan with an incompatible `ToolDefinition`.

**Tools B (AI/analysis):** clean engine/wrapper split in places (`summarizer`, `similarity-detector`), but Ollama hardcoded in `entity-tools`/`lancedb-tools`, glob/frontmatter IO copy-pasted 6×, keyword classification reinvented 5×, duplicate `dokoro_tag_stats` tool, stub analysis (`analyzeCluster`).

**Services:** good lazy-load of LanceDB and consistent SQLite-handle injection, but `IndexingService` `new`s all deps, Ollama `fetch` hardcoded with no provider port, `entity-extractor.ts` packs 3 responsibilities in 766 LOC, `EmbeddingCache` never wired in prod.

**DB / persistence:** clean Drizzle schema and append-only `migrations.ts`, but `index.ts` is an 867-LOC god object, no repository pattern, schema defined in 3 divergent places (`schema.ts` / `schema.sql` / `createTablesManually`), and the concrete store leaks into 14 files (27 refs, 79 raw-SQL sites).

**Cross-cutting:** good pure utils (`vector-math`, `lock-manager`, `themes`), but the layer that *should* hold the ports holds none — the only interface (`ToolConfig`) is dead, config is a global + 34 scattered `process.env` reads, `tool-tracker.ts` imports *upward* into `db/`, and `renderInkToString` / `FORCE_COLOR` are duplicated across files.
