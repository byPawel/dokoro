# Council: dokoro niche-expansion strategy

**Date**: 2026-06-11
**Pipeline**: Research (grok_search + perplexity_ask) → Debate (grok FOR / kimi AGAINST / gpt synthesis) → Reasoning chain (grok criteria → kimi scoring → gemini verdict + judge)
**Query**: Which 2-4 adjacent niches should dokoro attack next, and with what concrete features/positioning?

## Research highlights
- CooperBench: ~50% success drop when coding agents collaborate; failures concentrate in communication, commitments, ownership — maps directly to dokoro's claims/presence/handoffs.
- Local agent observability/session replay = HIGHEST demand signal in 2026; multi-agent coordination primitives = LEAST competition; benchmark-led (LongMemEval) = weakest standalone wedge (Mastra 94.87%, Mem0 ~94 on variants).
- MCP ecosystem: >5,500 servers, "MCP server" >60k searches/mo, riding Claude Code growth.
- Claude Code agent teams: task-claim file locks only; NO per-file claims; worktree isolation is the blessed pattern → same-worktree swarm demand is unproven.

## Debate
- FOR coordination-primary (grok): least competition, code already shipped, telemetry-enriched claims un-replicable, CooperBench launch demo.
- AGAINST (kimi): same-worktree parallel agents may be keynote fiction; solo maintainer can't ship two products; observability is a killing field (Langfuse/IBM + Claude Code could ship native history any quarter); affective layer risks being unqueried storage; alternative = own single-agent local memory end-to-end.
- Synthesis (gpt): don't pick either pole — "local-first memory and activity ledger for coding agents, with ownership and handoff primitives when concurrency appears."

## Scoring (criteria weighted for solo maintainer: maintainability 25%, time-to-value 20%, shipped-code leverage 15%, moat 15%, demand 15%, platform risk 10%)
| Option | Weighted score |
|---|---|
| (g) Synthesis: memory+ledger wedge, coordination as built-in safety | ~8.4 |
| (b) Local agent activity ledger / observability | 6.45 |
| (f) Affective telemetry standalone | 4.05 |
| (c) Benchmark-driven story | 3.80 |
| (a) Same-worktree coordination as PRIMARY | 3.15 |
| (e) CI/headless fleets | 3.05 |
| (d) PKM crossover | 3.00 |

## Verdict (HIGH confidence)
**Positioning**: "Local-first memory and browseable activity ledger for coding agents — claim files, leave handoffs, resume work without guessing. Works for one agent today; prevents collisions when you add another."

**Sequenced strategy**:
- Phase 1 (now–8 wks): 5-minute adoption path (init → MCP config → first memory → `dokoro browse`); sell single-agent continuity + the activity ledger; claims/handoffs framed as "prevent local agent confusion", not swarm orchestration.
- Phase 2 (2–4 mo): worktree-AWARE memory (bridge feature) — associate memories/claims with branch/worktree, show sibling-worktree overlap warnings, preserve handoffs across branch switches. Respects the blessed isolation pattern instead of fighting it.
- Phase 3 (4–6 mo): decision point — promote coordination to primary story ONLY if usage shows claims/handoffs adoption (pivot trigger: users reporting same-file collisions, claim-tool call volume).
- Affective layer: reframe as queryable FRICTION metadata ("show low-confidence changes", "where did the agent loop?") surfaced in browse TUI; keep hidden if unqueried.

**Avoid**: hosted observability SaaS, full multi-agent scheduler, enterprise trace analytics, benchmark-first marketing, PKM, CI-fleet backbone (for now).

**Top risks**: platform subsumption by native Claude Code history (mitigate: cross-session, editor-agnostic persistence); friction data unqueried (mitigate: surface visually in TUI); maintainer burnout (mitigate: strict MCP-server scope).

**What flips the decision**: evidence of real same-worktree multi-agent usage (collision reports, claim-call telemetry) → coordination becomes the headline; Claude Code shipping native cross-session memory → double down on worktree-aware + friction differentiation.
