<div align="center">

# 🧠 dokoro

### Agentic memory for coding agents — affective routing & bi-temporal facts

A multi-layer **agent memory** MCP server: a persistent brain for your LLM agent.
Remember what you're doing, what you did, what you know, and **how well each tool actually performs** — across sessions, models, and projects.
Claim files, leave handoffs, and resume work without guessing — works for one agent today; prevents collisions when you add another.

[![Website](https://img.shields.io/badge/website-bypawel.github.io%2Fdokoro-6e5494.svg)](https://bypawel.github.io/dokoro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Built on MCP](https://img.shields.io/badge/built%20on-MCP%20TypeScript%20SDK-orange.svg)](https://github.com/modelcontextprotocol/typescript-sdk)

</div>

> **Built on** the MCP TypeScript SDK.
> **Storage:** SQLite (Drizzle ORM) · LanceDB vectors · a small file-backed workspace.

---

## Why this exists

An LLM agent's context window is its only memory, and it's wiped at the end of every session. The agent re-learns the codebase, re-discovers decisions it already made, and repeats tools that failed last time. Most "memory" plugins paper over this with a single undifferentiated vector store — everything dumped in, everything retrieved by fuzzy similarity.

`dokoro` takes the opposite stance: **memory is separated by function**, following the CoALA-inspired taxonomy used by Letta, Zep, Mem0, and Cognee. Each layer answers a different question, so the agent retrieves *the right kind of memory* instead of the *most textually similar* one.

| The agent asks… | …and the right layer answers |
|---|---|
| "What was I doing?" | **Working** memory |
| "What happened last time?" | **Episodic** memory |
| "Have I seen this entity before?" | **Semantic** graph |
| "What plan am I executing?" | **Procedural** memory |
| "Does this tool usually work?" | **Affective** memory |

---

## In practice — a Claude Code session

**Monday.** Claude Code fixes a flaky login test and logs it as it goes:

```
You    ▸ The concurrent-login test is flaky. Fix it.
Claude ▸ [calls dokoro_session_log] Logged: root cause = race in session refresh,
         partial fix in auth/session.ts. Open question: needs a regression test.
```

**Thursday, fresh session, zero context.** Instead of re-investigating from scratch, Claude *recalls*:

```
You    ▸ Pick up the login bug from earlier this week.
Claude ▸ [calls dokoro_session_recall { query: "login", since: "2026-05-12" }]
         Resuming from Monday's session — writing the regression test now.
```

Summaries are written at session end with `dokoro_session_summary_add` (and tool outcomes are auto-captured along the way). `dokoro_session_recall` then returns the matching episodic summaries — narrowed by `query` substring and an ISO `since` bound, then semantically re-ranked by embedding similarity (falling back to recency when offline) — as compact text the agent reads directly. Long sessions are auto-compacted once their summaries grow past the token budget; the consolidated summary is retained as a single recallable entry, so nothing drops out of recall:

```
[2026-05-19T14:32:00Z] session=2026-05-19-login model=claude-opus-4-7 msgs=42
  Fixed race in session refresh; partial fix in auth/session.ts; TODO: regression test
```

---

## What makes it different

Most memory servers stop at "store text, retrieve by similarity." Two capabilities set `dokoro` apart — and both are queryable as plain MCP tool calls.

### ❤️ Affective memory — the agent learns which tools to trust

Every tool outcome is recorded — **outcome and latency are captured automatically** for wrapped tool calls; **confidence is recorded when provided** via an explicit `dokoro_feedback_record` call. The agent then asks `dokoro_feedback_route` for a **ranked** track record and biases itself accordingly — no other popular OSS memory lib (Mem0, Letta, Zep, Cognee, LangMem) does this natively.

```jsonc
// MCP tools/call — ranked routing scores for this agent
{
  "name": "dokoro_feedback_route",
  "arguments": { "agent_id": "claude-code", "half_life_days": 14 }
}
```
```
dokoro_session_recall:      n=89  success=89  failure=0 partial=0 rejected=0 timeout=0  decayed_rate=1.000 wilson_lower=0.9583 confident=true
dokoro_entity_extract_deep: n=142 success=125 failure=2 partial=0 rejected=0 timeout=15 decayed_rate=0.864 wilson_lower=0.8213 confident=true
```

> Ranking is a **Wilson lower bound** (so a single lucky success can't outrank a long track record) with **recency decay** (`half_life_days`, so stale failures fade) and a `confident` flag once a tool clears the minimum sample size. The agent prefers the higher `wilson_lower` — turning past outcomes into a routing policy. Raw aggregates remain available via `dokoro_feedback_query`.

### 🕒 Bi-temporal facts — query the graph "as of" any point in time

Every `entity_relations` row carries `valid_from` / `valid_to` (Zep/Graphiti-style), so facts are never destructively overwritten — a superseded fact has its window **closed** (`valid_to` set) and a new slice opens. Pass `as_of` and the graph traversal returns only the relations that were valid at that moment — point-in-time time-travel over the knowledge graph:

```jsonc
// MCP tools/call — what did this module relate to as of April 2026?
{
  "name": "dokoro_entity_graph",
  "arguments": { "entityId": 7, "as_of": "2026-04-01T00:00:00Z" }
}
```
```
## Entity: auth/session.ts
- **Type:** file
- **ID:** 7

### Relations (depth 2, 1 found)
- auth/session.ts --[uses]--> jwt-stateless-tokens
```

> Once that fact's window is closed, the default "now" view stops returning it — it only surfaces when you ask "as of" a date inside its validity window; the history is never deleted. Window-closing on supersession is active for **single-valued** relations (the set is empty by default — add types to `FUNCTIONAL_RELATION_TYPES` in `entity-extractor.ts` to enable it); genuinely **many-valued** relations like `depends_on` or `implements` accumulate concurrent open facts instead of evicting each other.

Plus: **hybrid search** (SQLite FTS5 + LanceDB vectors via Reciprocal Rank Fusion) and an **optional local LLM** (Ollama) for embeddings and deep entity extraction — the server runs fine without it, falling back to regex.

---

## How an agent uses it

`dokoro` is an MCP server: it exposes tools, and the agent — Claude Code, Gemini CLI, or any MCP client — calls them. There is no autonomy on the server side. **The server stores and serves; the agent reads and writes.** A typical session forms a loop across the layers:

```
   ┌──────────────────────────── session ────────────────────────────┐
   │                                                                   │
   ▼                                                                   │
 1. RESUME      workspace_status · session_recall      (read working + episodic)
 2. ORIENT      entity_graph · plan_status             (read semantic + procedural)
 3. ACT         workspace_claim · session_log          (write working)
 4. REFLECT     feedback_record                        (write affective)
 5. ROUTE       feedback_route                         (read affective)  ──┐
 6. PERSIST     workspace_dump                          (write → episodic) │
   │                                                                       │
   └───────────────────────────────────────────────────────────────────◄─┘
```

1. **Resume** — `dokoro_workspace_status` shows whether a task is already in flight; `dokoro_session_recall` loads summaries of prior sessions. The agent starts informed instead of blank.
2. **Orient** — `dokoro_entity_graph` reveals the relevant files/services/decisions and how they relate; `dokoro_plan_status` shows which plan tasks remain.
3. **Act** — it claims the workspace (`dokoro_workspace_claim`, a file-based lock so two agents don't collide), logs progress with `dokoro_session_log`, records open questions with `dokoro_question_add`.
4. **Reflect** — after each significant tool call, `dokoro_feedback_record` captures the outcome (success / failure / latency / confidence).
5. **Route** — `dokoro_feedback_query` lets the agent bias itself toward the model or tool that has historically succeeded.
6. **Persist** — `dokoro_workspace_dump` flushes the active workspace into durable storage, ready for the next recall.

The payoff: the agent never holds all of this in its context window. It pulls the slice it needs from the layer that owns it, then writes back what it learned.

---

## The five memory layers

| Layer | What it remembers | Where it lives | MCP tools |
|---|---|---|---|
| 🟢 **Working** | Current task, locks, open questions | `current-workspace.md` + `sessions(status='active')` + `questions.json` | `dokoro_workspace_claim`, `dokoro_workspace_dump`, `dokoro_workspace_status`, `dokoro_session_log`, `dokoro_question_*` |
| 🔵 **Episodic** | Past sessions, time entries, conversation summaries | `sessions`, `time_entries`, `conversation_summaries` | `dokoro_session_recall`, `dokoro_session_log` |
| 🟣 **Semantic** | Facts, entities, relations, tags, doc vectors | `entities`, `entity_relations` (bi-temporal), `doc_entities`, `tags`, `doc_tags`, `docs`, LanceDB `doc_vectors` + `chunks` | `dokoro_entity_graph`, `dokoro_entity_extract_deep` |
| 🟠 **Procedural** | Plans, workflows, checklists | `docs(doc_type='plan')` + plan JSON files | `dokoro_plan_create`, `dokoro_plan_check`, `dokoro_plan_validate`, `dokoro_plan_status`, `dokoro_plan_list`, `dokoro_plan_blocker` |
| 🔴 **Affective** | Per-tool/per-agent success, failure, latency, confidence | `agent_feedback` | `dokoro_feedback_record`, `dokoro_feedback_query` |

```
┌───────────── working ─────────────┐    ┌───────── affective ──────────┐
│  workspace.md │ sessions(active)   │    │  agent_feedback               │
└────────────────────────────────────┘    └───────────────────────────────┘
┌──── episodic ────┐  ┌────── semantic ──────┐  ┌──── procedural ────┐
│ sessions │ time_ │  │ entities │ relations │  │ docs(plan)         │
│ entries  │ conv_ │  │ doc_vectors (Lance)  │  │ plans/*.json       │
│ summaries│       │  │ tags │ doc_entities  │  │                    │
└──────────────────┘  └──────────┬───────────┘  └────────────────────┘
                                  │
                           Drizzle / SQLite
```

---

## Tools

Tools are organised by which memory layer they read or write.

<details open>
<summary><strong>🟢 Working memory</strong> — current task</summary>

| Tool | Description |
|------|-------------|
| `dokoro_workspace_status` | Check workspace status and active sessions |
| `dokoro_workspace_claim` | Claim workspace with a file-based lock |
| `dokoro_workspace_dump` | Export workspace data (registers docs in SQLite) |
| `dokoro_session_log` | Log development session entries with tags |
| `dokoro_regenerate_current` | Auto-generate or update `current.md` from recent activity |
| `dokoro_update_current_section` | Update a specific section in `current.md` |
| `dokoro_get_current_focus` | Read the current focus and active tasks from `current.md` |
| `dokoro_block_write` | Create/update a shared editable memory block (optimistic version lock) |
| `dokoro_block_read` | Read a shared block (content + version + last updater) |
| `dokoro_block_list` | List shared blocks (key, version, updater) |
| `dokoro_handoff_write` | Record a cross-session handoff (summary + open items) |
| `dokoro_handoff_inbox` | Read open handoffs targeted to / available to an agent |
| `dokoro_handoff_claim` | Atomically claim a handoff so only one agent takes it |
| `dokoro_presence_ping` | Heartbeat — announce this agent is active (status, focus) |
| `dokoro_presence_list` | List agents currently active in the project (read-time TTL) |
| `dokoro_file_claim` | Advisory per-file claim with a lease (default 300 s, max 3600 s) — warns other agents, never blocks |
| `dokoro_file_release` | Release your file claims (specific paths or `all:true`) — owner-aware, idempotent |
| `dokoro_claim_list` | List open file claims with holder liveness (`live` / `stale` / `unknown` via `agent_presence`) |
| `dokoro_question_add` | Log a question during development |
| `dokoro_question_answer` | Answer a previously logged question |
| `dokoro_question_list` | List all tracked questions |
| `dokoro_question_check` | Check status of open questions |

</details>

<details>
<summary><strong>🔵 Episodic memory</strong> — past sessions</summary>

| Tool | Description |
|------|-------------|
| `dokoro_session_recall` | Read past session summaries (filter by query, session_id, since timestamp) |
| `dokoro_session_summary_add` | Write a session-end summary — the episodic **write** path |
| `dokoro_compress_week` | Generate a compressed weekly summary (sessions, tasks completed, decisions made) — *analytics server only* |

</details>

<details>
<summary><strong>🟣 Semantic memory</strong> — facts and the knowledge graph</summary>

| Tool | Description |
|------|-------------|
| `dokoro_entity_graph` | Query the entity graph — search by name/type or traverse from a specific entity. Accepts `as_of` ISO timestamp for point-in-time queries against bi-temporal `entity_relations`. |
| `dokoro_entity_extract_deep` | Run LLM-powered deep extraction on a document via Ollama (requires `llama3.2`) |

</details>

<details>
<summary><strong>🟠 Procedural memory</strong> — plans and workflows</summary>

| Tool | Description |
|------|-------------|
| `dokoro_plan_create` | Create a development plan with tasks |
| `dokoro_plan_check` | Check progress on a plan's tasks |
| `dokoro_plan_blocker` | Report a blocker on a plan task |
| `dokoro_plan_validate` | Validate plan completion criteria |
| `dokoro_plan_status` | Get overall plan status summary |
| `dokoro_plan_list` | List all plans |

</details>

<details>
<summary><strong>🔴 Affective memory</strong> — agent feedback</summary>

| Tool | Description |
|------|-------------|
| `dokoro_feedback_record` | Record the outcome of a tool call (success / failure / partial / rejected / timeout) with confidence and latency |
| `dokoro_feedback_route` | Ranked track record (Wilson lower bound + recency decay) to bias tool/model routing |
| `dokoro_feedback_query` | Per-tool success rates, recent failures, agent-specific stats |

</details>

<details>
<summary><strong>⚙️ Other</strong> — setup and assets</summary>

| Tool | Description |
|------|-------------|
| `dokoro_init` | Initialize dokoro workspace and database |
| `dokoro_archive_sweep` | Sweep stale daily files and finished plans into the archive (`dryRun` to preview, `status_only` to inspect the last run) |
| `dokoro_save_image` | Save an image asset (base64 or URL) |
| `dokoro_save_file` | Save a file asset |
| `dokoro_list_assets` | List saved assets |

</details>

> Tools above are exposed by the **core server** (`bin/dokoro-core.js`). The optional **analytics server** (`bin/dokoro-analytics.js`) adds `dokoro_compress_week`. Other modular servers (search, planning, tracking) expose additional tools not yet wired into core — see `src/servers/*.ts`.

---

## Multi-agent file claims

When several agents share one worktree, `dokoro_file_claim` gives them an **advisory** per-file ledger: claim the files you're about to edit, and everyone else sees who is editing what. Claims **warn — they never block**:

- **Lease semantics** — a claim expires after `ttl_seconds` (default **300 s**, max **3600 s**); renew by re-claiming the same path (bumps a monotonic `heartbeat_seq` and extends the lease).
- **All-or-nothing** — claiming multiple paths either acquires every one or none; a conflict returns a per-path report with the live holder's `agent_id`, `intent`, expiry, and presence.
- **Stale takeover** — an expired claim, or one whose holder's `agent_presence` heartbeat is stale (> 900 s), is taken over automatically; `force:true` overrides even a live holder (recorded as a forced takeover).
- **One clock** — all timestamps are server-assigned SQLite `unixepoch` seconds, so agents on different machines can't disagree about expiry.

`dokoro_claim_list` shows open claims with holder liveness (`live` / `stale` / `unknown`); `dokoro_file_release` releases your own claims (and only yours). Backed by the `file_claims` table (migration v12).

---

## Automatic archiving

The workspace stays tidy without manual housekeeping:

- **Validated plans** — `dokoro_plan_validate` auto-archives a validated plan to `.mcp/plans/archive/YYYY-MM/`. Archived plans stay readable: `dokoro_plan_list` still lists them marked **(archived)**, and write tools refuse with a read-only error.
- **Opportunistic sweep** — `dokoro_workspace_claim` runs a conservative sweep: `daily/*.md` older than **7 days** (never the current ISO week, never files with a live claim) move to `archive/daily/YYYY-Www/`, and completed/validated plans older than **30 days** are archived.
- **On demand** — `dokoro_archive_sweep` runs the same sweep manually, with `dryRun:true` to preview and `status_only:true` to read `.mcp/archive-status.json` from the last run.

The sweep is a singleton (`.mcp/archive.lock`, 5-minute TTL — a crashed sweep's lock is broken automatically), index writes are atomic (temp file + rename), and every non-dry run records its results in `.mcp/archive-status.json`.

```
dokoro/
├── daily/                          # live session logs (current week + last 7 days)
├── archive/daily/2026-W20/         # swept daily files, partitioned by ISO week
└── .mcp/plans/
    ├── my-plan.json                # live plans
    └── archive/2026-06/            # finished plans, partitioned by month (read-only)
```

Filenames share one UTC slug — `YYYY-MM-DD-HHhMM-dayname` (e.g. `2026-06-10-22h23-wednesday`): session dumps are `<slug>-session-<topic>.md`, plan validation reports are `<slug>-validation-<planId>.md`.

---

## Browse it from the terminal

`dokoro browse` opens an interactive TUI over the whole memory folder — current workspace, daily sessions, weekly retrospectives, the archive, plans, file claims, agent presence, and the last sweep status:

```bash
npx dokoro browse                # auto-discovers the dokoro folder
npx dokoro browse --path=dokoro  # or point at one explicitly
```

Navigate with `↑`/`↓` and `enter`, go back with `esc`, filter-as-you-type with `/`, and scroll inside previews. In a non-TTY context (pipes, CI) it prints a static category summary instead.

---

## Works with your agent

Claude Code is the hero use case throughout this README, but `dokoro` is a standard MCP server — any MCP-compatible client connects the same way and speaks the same tools.

| Client / Agent | How it connects |
|---|---|
| **Claude Code** | Native MCP config (`claude mcp add …`) — see [Quick start](#quick-start) |
| **Gemini CLI** | MCP over stdio |
| **Cursor / Continue / Cline** | MCP extension or settings entry |
| **Any MCP client** | JSON-RPC 2.0 over stdio |

---

## Quick start

The fastest way — add it to a project with `npx`, no clone or build. **Run this from the project directory** you want memory for:

```bash
claude mcp add dokoro -- npx -y dokoro
```

That's it. Memory is **per-project**: each project gets its own isolated store in `./dokoro` (override with `DOKORO_PATH`), so sessions, entities, and tool-trust history never leak between projects. `npx -y dokoro` runs the unified server (all tools); subcommands like `npx dokoro init` and `npx dokoro migrate` hit the CLI.

<details>
<summary><strong>From source</strong> — for development or a pinned local checkout</summary>

```bash
# 1. Clone & install
git clone https://github.com/byPawel/dokoro
cd dokoro
npm install

# 2. Configure environment (API keys optional)
cp .env.example .env.local

# 3. Build
npm run build

# 4. Register (run from your target project dir; data lands in that project's ./dokoro)
claude mcp add dokoro "node" "/absolute/path/to/dokoro/bin/dokoro-core.js"
```

</details>

### Ollama setup (optional)

Enables embeddings and deep entity extraction. Needed only for `dokoro_entity_extract_deep` and LanceDB vector indexing — every other tool works without it.

```bash
# Install from https://ollama.com, then:
ollama pull nomic-embed-text
ollama pull llama3.2
ollama serve            # runs as a background service on most platforms
```

### Lean install — skip the native vector deps (optional)

`@lancedb/lancedb` and `apache-arrow` (the vector backend, ~100 MB of native deps) are declared as **`optionalDependencies`**. npm installs them by default, but you can skip them for a much lighter footprint:

```bash
npm install --omit=optional
```

The server still starts — LanceDB is **lazy-loaded**, so only the vector/semantic-search tools error (with an install hint) if you call them; everything else keeps working, and `dokoro_session_recall` falls back to substring + recency ranking. Add vectors later with `npm install @lancedb/lancedb apache-arrow`.

---

## Pairing with tachibot-mcp — memory for multi-model agents

[`tachibot-mcp`](https://github.com/byPawel/tachibot-mcp) is a multi-model orchestrator: it lets an agent reason, research, and plan across many models (Claude, GPT, Gemini, Grok, Perplexity, Qwen, Kimi…). The catch with multi-model work is that each call is stateless — the research one model did, or the plan another drafted, evaporates when the turn ends.

`dokoro` is tachibot's **memory backend**: tachibot does the thinking, dokoro remembers it. Three opt-in **bridge tools** (enable with `DOKORO_ENABLE_TACHIBOT_BRIDGE=true`) connect the two, so reasoning outputs land in the right memory layer and flow back into the next decision:

| Bridge tool | Direction | What it does |
|---|---|---|
| `bridge_index_research` | tachibot → **semantic** | Indexes research output (perplexity / grok / openai / gemini) into LanceDB. Deterministic IDs mean re-indexing the same `source`+`query` replaces the old entry — no duplicates. |
| `bridge_import_plan` | tachibot → **procedural** | Imports `planner_maker` phases into dokoro plans, so they work with `dokoro_plan_check` / `_validate` / `_status`. |
| `bridge_get_context` | **dokoro → tachibot** | Pulls relevant prior research + plans as a compact, paste-ready context block to seed the next reasoning call. |

### The agentic loop it enables

```
  ┌────────────────────────────────────────────────────────────────────┐
  ▼                                                                    │
  tachibot reasons / researches / plans  (multi-model)                 │
  │                                                                    │
  ├─ bridge_index_research  ─▶  dokoro semantic memory (LanceDB)       │
  ├─ bridge_import_plan     ─▶  dokoro procedural memory (plans)       │
  │                                                                    │
  next task: bridge_get_context  ◀──  dokoro recalls what’s relevant ──┘
```

The agent stops re-researching what it already looked up and stops re-planning what it already scoped. Each model's output compounds into shared, queryable memory — and because dokoro also tracks the affective layer (per-tool/per-agent success rates), the agent can even learn *which model* to route a given kind of task to.

> Bridge tools are exposed by the **search server** (and the unified server) only when `DOKORO_ENABLE_TACHIBOT_BRIDGE=true`; they're off by default so a plain dokoro install stays focused.

---

## How it compares

| Project | Architecture | Native temporal | Native affective |
|---|:---:|:---:|:---:|
| **dokoro** | SQLite + LanceDB + entity graph | ✅ bi-temporal relations | ✅ `agent_feedback` |
| Mem0 | Vector + optional graph | ❌ | ❌ |
| Letta (MemGPT) | Tiered, OS-like, self-editing | ◐ via metadata | ◐ via metadata |
| Zep / Graphiti | Temporal knowledge graph | ✅ bi-temporal | ❌ |
| Cognee | Graph + vector poly-store | ◐ partial | ❌ |
| LangMem | Modular over LangGraph | ❌ | ❌ |

---

## Development

```bash
npm install        # install dependencies
npm run dev:core   # run the core server in watch mode
npm run build      # build for production
npm test         # run tests
npm run lint     # lint code
```

### Project structure

```
dokoro/
├── src/
│   ├── servers/          # MCP server implementations
│   ├── tools/            # Tool implementations
│   ├── db/               # SQLite schema, migrations, Drizzle models
│   ├── utils/            # Utility functions
│   └── types/            # TypeScript type definitions
└── docs/                 # Architecture notes and plans
```

---

## License

[MIT](LICENSE) — see the LICENSE file for details.

## Acknowledgments

- Depends on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`), used under its MIT License.
- Implements the open Model Context Protocol.
