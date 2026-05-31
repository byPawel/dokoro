# Vector backend decision: commit to LanceDB, defer sqlite-vec

- **Date:** 2026-05-31
- **Status:** Decided
- **Scope:** How `devlog-mcp` stores and searches vectors for its semantic-memory layer.

## Decision

1. **Commit to the current stack: SQLite (Drizzle) + in-process LanceDB.** LanceDB
   is the single, committed vector backend.
2. **Do not build a pluggable vector-store adapter.** Rejected as premature
   abstraction (see rationale).
3. **Defer — but keep scoped — a future consolidation onto `sqlite-vec`** (one
   storage engine instead of two). This document is that roadmap.

The dead ChromaDB-era code (the symptom of the previously-unmade decision) is
removed in the same change set as this note.

## Context

ChromaDB was an earlier vector backend, later replaced by an in-process LanceDB
store. The Chroma code was never removed, leaving the repo with two apparent
backends and an unmade decision. A research + review pass settled it.

### Evidence (2025–2026 landscape)

- **The ecosystem splits into two camps, not a spectrum:** heavyweight
  pluggable-multi-backend systems (Mem0's `VectorStoreBase` + ~24 stores,
  Cognee's `VectorDBInterface`) that assume external services, vs. lightweight
  single-embedded-store servers (the official MCP `server-memory` = one JSONL
  file; `basic-memory`; `engram`; `ICM`). Adoption correlates with **zero
  external dependency / single binary**, not backend flexibility.
- **Only LanceDB and `sqlite-vec` are genuinely in-process.** Chroma is trending
  toward a server/cloud model; pgvector and Qdrant need a server; Turbopuffer is
  cloud-only. A pluggable layer's "other backends" are therefore mostly
  *non*-local-first, which conflicts with this project's identity.
- **The abstraction tax is real and specific to us.** A storage adapter forces
  the lowest common denominator and is leaky over heterogeneous vector semantics
  (hybrid search + metadata filtering genuinely differ across stores). Our
  bi-temporal `as_of` queries and FTS5 + LanceDB RRF fusion are exactly the
  backend-specific capabilities such an adapter would flatten. Multi-backend
  abstraction pays off only when swappability *is* the product (Mem0, LiteLLM);
  for a solo, local-first tool it is a maintainer hypothesis, not a user need.
- **"Be like supermemory" means connectors, not storage adapters.**
  Supermemory's pluggability is *ingestion* (Drive/Gmail/Notion/GitHub) over a
  *hardcoded* Postgres+pgvector cloud engine — not a swappable store.

### Repo facts

- `package.json` depends on `@lancedb/lancedb` only. ChromaDB was not a
  dependency and not wired into any server.
- LanceDB is isolated behind a single `VectorStoreService` (~70 lines, ~10 call
  sites). SQLite owns all chunk/doc metadata; LanceDB holds only vectors. The
  RRF fusion in the hybrid-search path is store-agnostic.
- The bi-temporal and affective layers live entirely in SQLite and are
  decoupled from the vector store.

## Options considered

| Option | Verdict |
|---|---|
| **1. Commit to LanceDB** (delete Chroma) | **Chosen.** Already in-process, zero-infra, working. |
| **2. Pluggable adapter** | Rejected. Premature abstraction; "other backends" are non-local-first; leaks over our hybrid/temporal semantics. |
| **3. Consolidate to `sqlite-vec`** (one engine) | Deferred. Cheap and attractive, but no present need and `sqlite-vec` is pre-v1.0. Roadmap below. |

## Roadmap — `sqlite-vec` consolidation (deferred)

**Goal:** collapse to a single storage engine — vectors living in the same
SQLite database as everything else — for the purest local-first, single-file
story (the `engram`/`ICM`/`basic-memory` cohort).

**Why it's attractive:** one file to back up, one failure mode, no second native
binary (`@lancedb/lancedb`) to complicate `npx`/cross-platform installs;
`sqlite-vec` is pure-C, has Node bindings, is Mozilla-backed, and is already the
de-facto companion for SQLite-based MCP memory servers.

**Pre-scoped migration (small, because LanceDB is well-isolated):**
- Replace the `VectorStoreService` implementation (init / add / deleteByDocId /
  search / count) with a `vec0` virtual table in the existing SQLite DB.
- Change `HybridSearchService.vectorSearch()` from LanceDB `_distance` to a
  `vec_distance` / `MATCH` query. The RRF fusion logic is store-agnostic and is
  untouched.
- Consumers (`bridge-service`, `lancedb-tools`, `background-indexer`) only call
  `searchService.search()` / `IndexingService`, so they need no changes.
- One-shot re-embed/reindex from source docs (no on-disk data-format migration,
  since Ollama re-embeds).
- **Estimate:** ~1–2 focused days of code + a reindex.

**Trigger to revisit (do it when one of these is true):**
- The `@lancedb/lancedb` native binary causes real install/packaging friction on
  a target platform.
- `sqlite-vec` reaches a stable v1.0.
- The "single-file, zero-infra" positioning becomes a deliberate launch pitch.

**Risk:** `sqlite-vec` is pre-v1.0 (breaking-change warnings) — the main reason
not to migrate now.

### When pluggable *would* become right

If a real user/issue requests a server-backed vector store for a multi-machine
or team deployment, *and* there is a second concrete local-first engine to design
against (e.g. `sqlite-vec` at v1.0). Design an interface against ≥2 real
implementations — never one-plus-a-guess.

## Where effort goes instead

Not storage. The differentiators no competitor has natively — bi-temporal
`as_of` and the affective `feedback_route` layer — plus the connector/integration
surface (the supermemory lesson) are the higher-leverage investments.
