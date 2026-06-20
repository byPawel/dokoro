# Council: CLAUDE.md golfing — Agent Operating Rules + Validation & Release Discipline

**Date**: 2026-06-11 05:59
**Query**: Review CLAUDE.md changes (Karpathy behavior rules + Claude /insights recommendations). Goal: golf high-signal rules for dokoro, avoid bloat. Verdict: keep as-is vs exact patch suggestions only.
**Pipeline**: Research → Debate → Reasoning Chain → Resolution
**Models**: grok (search, pro-debate, criteria), perplexity (research), kimi (con-debate, scoring), gpt-5.4 (synthesis), gemini (final judge ×2)
**Fallbacks**: perplexity_research unavailable → grok_search + perplexity_ask; focus returned only chain setup → parallel grok_reason/kimi_thinking/openai_reason; nextThought step 3 (openai) tool fallback → skipped, folded into step 4.

## Research summary
- Karpathy's 4 rules are an anti-bloat *menu*, meant to be merged with project specifics, not pasted wholesale.
- Anthropic/practitioner consensus: concrete executable imperatives beat generic behavioral prose; bloat causes rule-ignoring; add rules only when real failures revealed a need.
- Target shape: compressed operating manual for THIS repo, ~300 lines max.

## Debate highlights
- **PRO (grok)**: bullets target real failure modes (over-abstraction, false "tests passed"); workflow rules are legitimate cross-session coordination memory.
- **CON (kimi)**: "Think before coding", "Surgical changes", "No fake success" restate harness defaults; merge/release bullet duplicates Build & Test Commands; **"Vitest" is a factual error — project uses Jest** — and wrong specifics teach the model to distrust the file.
- **SYNTHESIS (gpt-5.4)**: patch — keep behavioral teeth (simplicity, surgical, no-fake-success, test-for-bugfix), merge validation into Build & Test Commands, fix Jest wording, keep the three workflow rules (worktree, noreply email, subagent batching) as they reflect the real multi-session/council workflow.

## Reasoning chain
Criteria weights: repo-specific behavior change 9, single source of truth 9, factual accuracy 8, real observed failure 7, token cost 6.
Per-bullet: CUT think-before-coding + goal-driven-execution; KEEP/TRIM simplicity-first, surgical-changes, no-fake-success; MERGE merge/release checklist into Build & Test Commands; REWORD Vitest→Jest; KEEP worktree-check, noreply-email, subagent-batching.

## Final recommendation
**PATCH, do not keep as-is.** Confidence: **High** (gemini judge ×2, unanimous on the Jest fix and dedup; only grok defended full keep).
- Replace the two sections with one golfed "Agent Operating Rules" (6 bullets) and fold validation into Build & Test Commands.
- ~16 added lines → ~10, factual error fixed, single source of truth for commands.
- What would flip it: if the harness stopped enforcing think-first/surgical defaults, the generic bullets would earn their place back.
