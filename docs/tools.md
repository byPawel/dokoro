# Dokoro MCP Tools Documentation

This document provides detailed information about all available tools in the Dokoro MCP servers.

## Core Server Tools

### dokoro_workspace_status

Check the current workspace status including active agents and locks.

**Parameters:**
- None

**Returns:**
- `exists`: Boolean indicating if workspace exists
- `currentAgent`: Current agent ID (if any)
- `lastActive`: Last activity timestamp
- `isLocked`: Lock status
- `lockInfo`: Detailed lock information if locked

**Example:**
```typescript
const status = await dokoro_workspace_status();
// Returns: { exists: true, currentAgent: "agent-12345", isLocked: false }
```

### dokoro_workspace_claim

Claim a workspace with multi-agent lock support and session tracking.

**Parameters:**
- `task` (string, required): Current task or focus area
- `force` (boolean, optional): Force claim even if locked
- `tags` (object, optional): Session tags

**Returns:**
- Success message with session details
- Error message if claim fails

**Example:**
```typescript
const result = await dokoro_workspace_claim({
  task: "Implement user authentication",
  tags: { feature: "auth", priority: "high" }
});
```

### dokoro_workspace_dump

Export the current workspace data including session information.

**Parameters:**
- `format` (string, optional): Output format ("json" or "markdown", default: "json")

**Returns:**
- Workspace data in requested format

**Example:**
```typescript
const data = await dokoro_workspace_dump({ format: "markdown" });
```

### dokoro_session_log

Log entries for the current development session.

**Parameters:**
- `entries` (string[], required): Log entries to add
- `tags` (object, optional): Additional tags
- `summary` (string, optional): Session summary

**Returns:**
- Success confirmation with entry count

**Example:**
```typescript
await dokoro_session_log({
  entries: [
    "Implemented login endpoint",
    "Added JWT token generation",
    "Fixed CORS issues"
  ],
  tags: { completed: true },
  summary: "Authentication system complete"
});
```

### dokoro_current_update

Update the current.md file with latest information.

**Parameters:**
- `content` (string, required): New content for current.md
- `append` (boolean, optional): Append instead of replace

**Returns:**
- Success confirmation

**Example:**
```typescript
await dokoro_current_update({
  content: "## Today's Progress\n- Completed auth implementation",
  append: true
});
```

### dokoro_file_claim

Place an ADVISORY claim on one or more files so cooperating agents can see who is editing what. Claims warn — they never block edits. Acquisition is all-or-nothing: if any path is held by a live agent (and `force` is not set), nothing is claimed and a per-path conflict report is returned. Re-claiming your own file renews the lease (extends expiry, bumps `heartbeat_seq`). Claims whose lease expired, or whose holder's `agent_presence` heartbeat is stale (older than 900 seconds), are taken over automatically. All timestamps are server-assigned SQLite unixepoch seconds.

**Parameters:**
- `paths` (string[], required): Files to claim, 1–50 entries (relative to `root`, or absolute under it)
- `agent_id` (string, required): Your stable agent identity
- `session_id` (string, optional): Session identifier
- `intent` (string, optional): What you plan to do with these files (shown to other agents)
- `ttl_seconds` (number, optional): Lease duration in seconds (default: 300, max: 3600); renew by re-claiming
- `root` (string, optional): Workspace root the paths are relative to (default: server process cwd); claims store only normalized root-relative paths, so all agents must use the same root
- `force` (boolean, optional): Override even live holders, recorded as a forced takeover (default: false)

**Returns:**
- On success: per-path report with status `claimed`, `renewed`, `taken_over`, or `taken_over_forced`, plus the lease expiry
- On conflict (not an error): per-path report — `conflict` entries carry the holder's `agent_id`, `intent`, `expires_in_seconds`, and presence (`live`/`stale`/`unknown`); nothing is claimed

**Example:**
```typescript
const result = await dokoro_file_claim({
  paths: ["src/auth/session.ts", "src/auth/tokens.ts"],
  agent_id: "claude-code",
  intent: "refactoring token refresh",
  ttl_seconds: 600
});
// Conflict? Wait for the lease, claim other files, or retry with force: true
```

### dokoro_file_release

Release advisory file claims held by you: specific paths, or everything you hold. Owner-aware (you can only release your own claims) and idempotent — unknown or already-released paths report `not_found`, never an error.

**Parameters:**
- `agent_id` (string, required): Your stable agent identity (only your claims are released)
- `paths` (string[], optional): Specific files to release, 1–50 entries (omit when using `all`)
- `all` (boolean, optional): Release every open claim held by `agent_id` (mutually exclusive with `paths`)
- `root` (string, optional): Workspace root the paths are relative to (default: server process cwd)

**Returns:**
- Per-path report with status `released`, `not_held_by_you`, or `not_found`

**Example:**
```typescript
await dokoro_file_release({ agent_id: "claude-code", all: true });
// or release selectively:
await dokoro_file_release({
  agent_id: "claude-code",
  paths: ["src/auth/session.ts"]
});
```

### dokoro_claim_list

List open advisory file claims, soonest expiry first, with holder liveness corroborated from `agent_presence`: `live` = heartbeat within 900 seconds, `stale` = older heartbeat, `unknown` = the agent never pinged. Expired claims are hidden unless requested.

**Parameters:**
- `agent_id` (string, optional): Only show claims held by this agent
- `include_expired` (boolean, optional): Also show open claims whose lease already expired (default: false)
- `root` (string, optional): Informational — listed paths are root-relative

**Returns:**
- Markdown table plus JSON: per claim `path`, `agent_id`, `intent`, `expires_in_seconds`, `heartbeat_seq`, `presence`

**Example:**
```typescript
const claims = await dokoro_claim_list({ include_expired: true });
// | path | agent | intent | expires_in_s | presence |
```

### dokoro_archive_sweep

Archive stale workspace files on demand. `daily/*.md` older than `olderThanDays` move to `archive/daily/<ISO week>/` — the current ISO week and files with a live advisory claim are never touched — and completed/validated plans older than `planOlderThanDays` move to `.mcp/plans/archive/<YYYY-MM>/` (still listed by `dokoro_plan_list`, read-only). The sweep is a singleton guarded by `.mcp/archive.lock` (5-minute TTL); a concurrent run reports `skipped: locked`, which is benign.

**Parameters:**
- `olderThanDays` (number, optional): Daily files older than this many days are eligible (default: 7)
- `planOlderThanDays` (number, optional): Completed/validated plans older than this many days are archived (default: 30)
- `dryRun` (boolean, optional): Preview only — report what WOULD move without touching anything (default: **false** — by default files ARE moved)
- `status_only` (boolean, optional): Skip sweeping; pretty-print `.mcp/archive-status.json` from the last sweep (default: false)

**Returns:**
- Counts and lists of daily files moved and plans archived, plus per-file errors (which do not fail the sweep)
- With `status_only`: last run time, moved/archived counts, and last error from `.mcp/archive-status.json`

**Example:**
```typescript
// Preview first, then sweep
await dokoro_archive_sweep({ dryRun: true });
await dokoro_archive_sweep({ olderThanDays: 14 });
// Inspect the last run
await dokoro_archive_sweep({ status_only: true });
```

## Analytics Server Tools

### dokoro_analytics_summary

Get a summary of development analytics.

**Parameters:**
- `days` (number, optional): Number of days to analyze (default: 7)

**Returns:**
- Total sessions
- Total time spent
- Most active days
- Top tasks/tags

**Example:**
```typescript
const summary = await dokoro_analytics_summary({ days: 30 });
```

### dokoro_analytics_patterns

Analyze work patterns and productivity insights.

**Parameters:**
- `startDate` (string, optional): Start date (ISO format)
- `endDate` (string, optional): End date (ISO format)

**Returns:**
- Work patterns by hour/day
- Peak productivity times
- Task completion rates

### dokoro_analytics_report

Generate a detailed analytics report.

**Parameters:**
- `startDate` (string, required): Start date
- `endDate` (string, required): End date
- `groupBy` (string, optional): Group by "tag", "task", or "day"
- `format` (string, optional): "json" or "markdown"

**Returns:**
- Comprehensive analytics report

## Planning Server Tools

### dokoro_plan_create

Create a new development plan.

**Parameters:**
- `goal` (string, required): Main goal or objective
- `tasks` (string[], optional): List of tasks
- `context` (string, optional): Additional context
- `useAI` (boolean, optional): Use AI for plan generation

**Returns:**
- Created plan with ID and details

**Example:**
```typescript
const plan = await dokoro_plan_create({
  goal: "Implement OAuth2 integration",
  tasks: [
    "Research OAuth2 providers",
    "Design authentication flow",
    "Implement provider integration"
  ],
  context: "Existing JWT auth in place"
});
```

### dokoro_plan_update

Update an existing plan.

**Parameters:**
- `planId` (string, required): Plan ID
- `updates` (object, required): Fields to update

**Returns:**
- Updated plan details

### dokoro_task_add

Add a new task to the current plan.

**Parameters:**
- `task` (string, required): Task description
- `priority` (string, optional): "low", "medium", "high"
- `tags` (string[], optional): Task tags
- `planId` (string, optional): Associated plan ID

**Returns:**
- Created task with ID

### dokoro_task_update

Update task status or details.

**Parameters:**
- `taskId` (string, required): Task ID
- `status` (string, optional): "pending", "in-progress", "completed"
- `notes` (string, optional): Additional notes

**Returns:**
- Updated task details

## Search Server Tools

### dokoro_search

Basic search across all development logs.

**Parameters:**
- `query` (string, required): Search query
- `limit` (number, optional): Maximum results (default: 10)
- `offset` (number, optional): Results offset

**Returns:**
- Array of matching log entries

**Example:**
```typescript
const results = await dokoro_search({
  query: "authentication bug",
  limit: 20
});
```

### dokoro_search_semantic

AI-powered semantic search using embeddings.

**Parameters:**
- `query` (string, required): Search query
- `useEmbeddings` (boolean, optional): Use semantic search
- `threshold` (number, optional): Similarity threshold (0-1)
- `limit` (number, optional): Maximum results

**Returns:**
- Semantically similar entries with relevance scores

### dokoro_search_by_date

Search within specific date ranges.

**Parameters:**
- `startDate` (string, required): Start date (ISO format)
- `endDate` (string, required): End date
- `query` (string, optional): Additional text filter

**Returns:**
- Entries within date range

### dokoro_search_by_tag

Search entries by tags.

**Parameters:**
- `tags` (string[], required): Tags to search for
- `matchAll` (boolean, optional): Require all tags (default: false)

**Returns:**
- Entries matching tag criteria

## Error Handling

All tools follow consistent error handling:

1. **Missing Parameters**: Returns error with missing parameter details
2. **Invalid Parameters**: Returns validation error with specifics
3. **System Errors**: Returns error with message and optional stack trace
4. **Lock Conflicts**: Returns specific lock conflict information

## Best Practices

1. **Always check workspace status** before claiming
2. **Use meaningful task descriptions** for better analytics
3. **Tag consistently** for effective searching
4. **Log regularly** throughout development sessions
5. **Use force claim sparingly** - respect other agents' locks
6. **Batch log entries** when possible for performance

## Rate Limits

- No hard rate limits on tool calls
- Workspace claims have built-in lock timeouts
- Search operations may be throttled if using AI features

## Integration Examples

### Full Session Workflow

```typescript
// 1. Check and claim workspace
const status = await dokoro_workspace_status();
if (!status.isLocked || status.lockInfo.isExpired) {
  await dokoro_workspace_claim({
    task: "Feature: User Dashboard",
    tags: { sprint: "S24-3", team: "frontend" }
  });
}

// 2. Create a plan
const plan = await dokoro_plan_create({
  goal: "Implement user dashboard",
  tasks: [
    "Design dashboard layout",
    "Create API endpoints",
    "Implement frontend components"
  ]
});

// 3. Work and log progress
await dokoro_session_log({
  entries: ["Completed dashboard wireframes"],
  tags: { milestone: "design-complete" }
});

// 4. Update task status
await dokoro_task_update({
  taskId: plan.tasks[0].id,
  status: "completed"
});

// 5. Search for related work
const related = await dokoro_search_semantic({
  query: "dashboard implementation patterns",
  useEmbeddings: true
});

// 6. Generate analytics
const report = await dokoro_analytics_summary({ days: 7 });
```