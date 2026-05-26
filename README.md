<div align="center">

# 🧠 devlog-mcp

### Agent memory for Claude Code — with affective routing & bi-temporal facts

A multi-layer **agent memory** MCP server: a persistent brain for your LLM agent.
Remember what you're doing, what you did, what you know, and **how well each tool actually performs** — across sessions, models, and projects.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Built on MCP](https://img.shields.io/badge/built%20on-MCP%20TypeScript%20SDK-orange.svg)](https://github.com/modelcontextprotocol/typescript-sdk)

</div>

> **Built on** Anthropic's MCP TypeScript SDK.
> **Storage:** SQLite (Drizzle ORM) · LanceDB vectors · a small file-backed workspace.

---

## Why this exists

An LLM agent's context window is its only memory, and it's wiped at the end of every session. The agent re-learns the codebase, re-discovers decisions it already made, and repeats tools that failed last time. Most "memory" plugins paper over this with a single undifferentiated vector store — everything dumped in, everything retrieved by fuzzy similarity.

`devlog-mcp` takes the opposite stance: **memory is separated by function**, following the CoALA-inspired taxonomy used by Letta, Zep, Mem0, and Cognee. Each layer answers a different question, so the agent retrieves *the right kind of memory* instead of the *most textually similar* one.

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
Claude ▸ [calls devlog_session_log] Logged: root cause = race in session refresh,
         partial fix in auth/session.ts. Open question: needs a regression test.
```

**Thursday, fresh session, zero context.** Instead of re-investigating from scratch, Claude *recalls*:

```
You    ▸ Pick up the login bug from earlier this week.
Claude ▸ [calls devlog_session_recall { query: "login", since: "2026-05-12" }]
         Resuming from Monday's session — writing the regression test now.
```

`devlog_session_recall` returns the matching episodic summaries (filtered by `query` substring and an ISO `since` bound) as compact text the agent reads directly:

```
[2026-05-19T14:32:00Z] session=2026-05-19-login model=claude-opus-4-7 msgs=42
  Fixed race in session refresh; partial fix in auth/session.ts; TODO: regression test
```

---

## What makes it different

Most memory servers stop at "store text, retrieve by similarity." Two capabilities set `devlog-mcp` apart — and both are queryable as plain MCP tool calls.

### ❤️ Affective memory — the agent learns which tools to trust

Every tool outcome is recorded with `devlog_feedback_record` (outcome, confidence, latency). Later, the agent asks for a tool's track record and **routes itself accordingly** — no other popular OSS memory lib (Mem0, Letta, Zep, Cognee, LangMem) does this natively.

```jsonc
// MCP tools/call — per-tool stats for this agent
{
  "name": "devlog_feedback_query",
  "arguments": { "agent_id": "claude-code" }
}
```
```
devlog_entity_extract_deep: total=142 success=125 failure=2 success_rate=0.88 avg_confidence=0.91
devlog_session_recall:      total=89  success=89  failure=0 success_rate=1.0  avg_confidence=0.97
```

> The agent reads `success_rate` per tool and biases its next decision toward what has actually worked — turning past outcomes into a routing signal. Filter by `tool_name`, `agent_id`, or `since`.

### 🕒 Bi-temporal facts — query the graph "as of" any point in time

Every `entity_relations` row carries `valid_from` / `valid_to` (Zep/Graphiti-style). Contradictions don't overwrite — they **close a window**. Pass `as_of` and the graph traversal returns only the relations that were valid at that moment:

```jsonc
// MCP tools/call — what did this module relate to as of April 2026?
{
  "name": "devlog_entity_graph",
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

> Drop `as_of` (the default "now" view) and the superseded edge falls out of the result — you'd instead see `auth/session.ts --[uses]--> oauth2-sessions`. The historical fact isn't deleted; its validity window simply closed, so it only surfaces when you ask "as of" a date inside that window.

Plus: **hybrid search** (SQLite FTS5 + LanceDB vectors via Reciprocal Rank Fusion) and an **optional local LLM** (Ollama) for embeddings and deep entity extraction — the server runs fine without it, falling back to regex.

---

## How an agent uses it

`devlog-mcp` is an MCP server: it exposes tools, and the agent — Claude Code, Gemini CLI, or any MCP client — calls them. There is no autonomy on the server side. **The server stores and serves; the agent reads and writes.** A typical session forms a loop across the layers:

```
   ┌──────────────────────────── session ────────────────────────────┐
   │                                                                   │
   ▼                                                                   │
 1. RESUME      workspace_status · session_recall      (read working + episodic)
 2. ORIENT      entity_graph · plan_status             (read semantic + procedural)
 3. ACT         workspace_claim · session_log          (write working)
 4. REFLECT     feedback_record                        (write affective)
 5. ROUTE       feedback_query                         (read affective)  ──┐
 6. PERSIST     workspace_dump                          (write → episodic) │
   │                                                                       │
   └───────────────────────────────────────────────────────────────────◄─┘
```

1. **Resume** — `devlog_workspace_status` shows whether a task is already in flight; `devlog_session_recall` loads summaries of prior sessions. The agent starts informed instead of blank.
2. **Orient** — `devlog_entity_graph` reveals the relevant files/services/decisions and how they relate; `devlog_plan_status` shows which plan tasks remain.
3. **Act** — it claims the workspace (`devlog_workspace_claim`, a file-based lock so two agents don't collide), logs progress with `devlog_session_log`, records open questions with `devlog_question_add`.
4. **Reflect** — after each significant tool call, `devlog_feedback_record` captures the outcome (success / failure / latency / confidence).
5. **Route** — `devlog_feedback_query` lets the agent bias itself toward the model or tool that has historically succeeded.
6. **Persist** — `devlog_workspace_dump` flushes the active workspace into durable storage, ready for the next recall.

The payoff: the agent never holds all of this in its context window. It pulls the slice it needs from the layer that owns it, then writes back what it learned.

---

## The five memory layers

| Layer | What it remembers | Where it lives | MCP tools |
|---|---|---|---|
| 🟢 **Working** | Current task, locks, open questions | `current-workspace.md` + `sessions(status='active')` + `questions.json` | `devlog_workspace_claim`, `devlog_workspace_dump`, `devlog_workspace_status`, `devlog_session_log`, `devlog_question_*` |
| 🔵 **Episodic** | Past sessions, time entries, conversation summaries | `sessions`, `time_entries`, `conversation_summaries` | `devlog_session_recall`, `devlog_session_log` |
| 🟣 **Semantic** | Facts, entities, relations, tags, doc vectors | `entities`, `entity_relations` (bi-temporal), `doc_entities`, `tags`, `doc_tags`, `docs`, LanceDB `doc_vectors` + `chunks` | `devlog_entity_graph`, `devlog_entity_extract_deep` |
| 🟠 **Procedural** | Plans, workflows, checklists | `docs(doc_type='plan')` + plan JSON files | `devlog_plan_create`, `devlog_plan_check`, `devlog_plan_validate`, `devlog_plan_status`, `devlog_plan_list`, `devlog_plan_blocker` |
| 🔴 **Affective** | Per-tool/per-agent success, failure, latency, confidence | `agent_feedback` | `devlog_feedback_record`, `devlog_feedback_query` |

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
| `devlog_workspace_status` | Check workspace status and active sessions |
| `devlog_workspace_claim` | Claim workspace with a file-based lock |
| `devlog_workspace_dump` | Export workspace data (registers docs in SQLite) |
| `devlog_session_log` | Log development session entries with tags |
| `devlog_question_add` | Log a question during development |
| `devlog_question_answer` | Answer a previously logged question |
| `devlog_question_list` | List all tracked questions |
| `devlog_question_check` | Check status of open questions |

</details>

<details>
<summary><strong>🔵 Episodic memory</strong> — past sessions</summary>

| Tool | Description |
|------|-------------|
| `devlog_session_recall` | Read past session summaries (filter by query, session_id, since timestamp) |
| `devlog_compress_week` | Generate a compressed weekly summary (sessions, decisions, mermaid charts) |

</details>

<details>
<summary><strong>🟣 Semantic memory</strong> — facts and the knowledge graph</summary>

| Tool | Description |
|------|-------------|
| `devlog_entity_graph` | Query the entity graph — search by name/type or traverse from a specific entity. Accepts `as_of` ISO timestamp for point-in-time queries against bi-temporal `entity_relations`. |
| `devlog_entity_extract_deep` | Run LLM-powered deep extraction on a document via Ollama (requires `llama3.2`) |

</details>

<details>
<summary><strong>🟠 Procedural memory</strong> — plans and workflows</summary>

| Tool | Description |
|------|-------------|
| `devlog_plan_create` | Create a development plan with tasks |
| `devlog_plan_check` | Check progress on a plan's tasks |
| `devlog_plan_blocker` | Report a blocker on a plan task |
| `devlog_plan_validate` | Validate plan completion criteria |
| `devlog_plan_status` | Get overall plan status summary |
| `devlog_plan_list` | List all plans |

</details>

<details>
<summary><strong>🔴 Affective memory</strong> — agent feedback</summary>

| Tool | Description |
|------|-------------|
| `devlog_feedback_record` | Record the outcome of a tool call (success / failure / partial / rejected / timeout) with confidence and latency |
| `devlog_feedback_query` | Per-tool success rates, recent failures, agent-specific stats |

</details>

<details>
<summary><strong>⚙️ Other</strong> — setup and assets</summary>

| Tool | Description |
|------|-------------|
| `devlog_init` | Initialize devlog workspace and database |
| `devlog_save_image` | Save an image asset (base64 or URL) |
| `devlog_save_file` | Save a file asset |
| `devlog_list_assets` | List saved assets |

</details>

> Tools above are exposed by the **core server** (`dist/servers/core-server.js`). The optional **analytics server** (`dist/servers/analytics-server.js`) adds `devlog_compress_week`. Other modular servers (search, planning, tracking) expose additional tools not yet wired into core — see `src/servers/*.ts`.

---

## Works with your agent

Claude Code is the hero use case throughout this README, but `devlog-mcp` is a standard MCP server — any MCP-compatible client connects the same way and speaks the same tools.

| Client / Agent | How it connects |
|---|---|
| **Claude Code** | Native MCP config (`claude mcp add …`) — see [Quick start](#quick-start) |
| **Gemini CLI** | MCP over stdio |
| **Cursor / Continue / Cline** | MCP extension or settings entry |
| **Any MCP client** | JSON-RPC 2.0 over stdio |

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/byPawel/devlog-mcp
cd devlog-mcp

# 2. Install dependencies
npm install

# 3. Configure environment (API keys optional)
cp .env.example .env.local

# 4. Build
npm run build
```

Register the server with Claude:

```bash
# Core server (essential features)
claude mcp add devlog-core "node" "$(pwd)/dist/servers/core-server.js"

# …or with environment variables
claude mcp add devlog-core "$(pwd)/../mcp-wrapper.sh" ".env.local" "node" "$(pwd)/dist/servers/core-server.js"
```

### Ollama setup (optional)

Enables embeddings and deep entity extraction. Needed only for `devlog_entity_extract_deep` and LanceDB vector indexing — every other tool works without it.

```bash
# Install from https://ollama.com, then:
ollama pull nomic-embed-text
ollama pull llama3.2
ollama serve            # runs as a background service on most platforms
```

---

## How it compares

| Project | Architecture | Native temporal | Native affective |
|---|:---:|:---:|:---:|
| **devlog-mcp** | SQLite + LanceDB + entity graph | ✅ bi-temporal relations | ✅ `agent_feedback` |
| Mem0 | Vector + optional graph | ❌ | ❌ |
| Letta (MemGPT) | Tiered, OS-like, self-editing | ◐ via metadata | ◐ via metadata |
| Zep / Graphiti | Temporal knowledge graph | ✅ bi-temporal | ❌ |
| Cognee | Graph + vector poly-store | ◐ partial | ❌ |
| LangMem | Modular over LangGraph | ❌ | ❌ |

---

## Development

```bash
npm install      # install dependencies
npm run dev      # run in development mode
npm run build    # build for production
npm test         # run tests
npm run lint     # lint code
```

### Project structure

```
devlog-mcp/
├── src/
│   ├── servers/          # MCP server implementations
│   ├── tools/            # Tool implementations
│   ├── db/               # SQLite schema, migrations, Drizzle models
│   ├── utils/            # Utility functions
│   └── types/            # TypeScript type definitions
├── docs/                 # Architecture notes and plans
└── examples/             # Usage examples
```

---

## License

[MIT](LICENSE) — see the LICENSE file for details.

## Acknowledgments

- Built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) by Anthropic.
- Original SDK © 2024 Anthropic, PBC — MIT License.
- Thanks to the Anthropic team for creating the Model Context Protocol.
