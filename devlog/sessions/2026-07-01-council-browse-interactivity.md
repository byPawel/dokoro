# Council: dokoro browse interactivity feature set

**Date**: 2026-07-01
**Query**: Which interactivity features should we add to the `dokoro browse` Ink TUI, in what priority, and with what input architecture?
**Pipeline**: Research → Debate (fallback: parallel FOR/AGAINST/synthesis) → 3-thought reasoning chain → gemini_judge resolve
**Models**: grok (search, FOR, criteria), perplexity (research), kimi (AGAINST, scoring), gpt-5.4 (synthesis), gemini (verdict + judge + resolve)
**Fallbacks used**: perplexity_research unavailable → grok_search + perplexity_ask; focus session expired → parallel grok_reason/kimi_thinking/openai_reason

## Research summary

Mature TUIs (k9s, lazygit, htop, tig) converge on contextual single-key actions +
y/n confirms for <20 actions; `?` help overlay is the discoverability standard;
command palettes only pay off for large multi-view tools; $EDITOR
suspend/exec/resume is standard; mouse support and nested menus are
overengineering.

## Debate highlights

- **FOR (grok)**: ship `?`, `e` ($EDITOR), `r` (release-claim), plan
  validate/check-off, answer-question — all single-key + confirm.
- **AGAINST (kimi)**: the dashboard should watch agents, not fight them —
  release-claim races agent reclaims, plan check-off collides with MCP writes,
  $EDITOR suspend is fragile in Ink raw mode, every overlay multiplies the
  useInput mode matrix.
- **SYNTHESIS (gpt-5.4)**: observe-first; gate every mutation with confirm +
  fresh-read-before-write; narrow mode-map refactor
  (normal/text/help/confirm/suspended); reject palette, inline answering, NL box.

## Scoring (weighted: safety 35 / supervision 25 / mode-cost 20 / size 15 / NL-wedge 5)

| Candidate | Score | Outcome |
|---|---|---|
| Read-only questions + feedback categories | 84.5 | ship (phase 1) |
| `?` help overlay | 82.5 | ship (phase 2) |
| `p` single plan transition | 66.5 | ship gated (phase 2) |
| `r` release-claim | 64 | ship gated (phase 2) |
| useInput mode-map refactor | 61.5 | do first (enabler, ≥2 modal features) |
| `e` open-in-$EDITOR | 55.5 | phase 3, after raw-mode restore spike |
| Inline answer-question | 54 | reject (claims NL wedge, 4th typing mode) |
| Generic action menu | 45 | reject |
| Multi-select archive | 37 | reject |

## Final recommendation

Phased rollout:
1. **Foundation**: narrow useInput mode-map refactor (normal / existing text
   modes / help / confirm) + read-only `questions` and `feedback` categories.
2. **Safe interactivity**: `?` help overlay; `p` plan transition and `r`
   release-claim behind y/n confirm + fresh-read-before-write + idle/stale gate
   keyed off existing `heartbeat_seq` / `expires_at` / `PRESENCE_TTL_SECONDS`.
3. **High-risk**: `e` open-in-$EDITOR only after a suspend/resume spike proves
   terminal restore; abandon if Ink raw mode proves unstable.

**Why it wins**: a coordination dashboard must not corrupt agent memory; the
mode-map stabilizes input before any new modal feature, and
fresh-read-before-write + TTL gating prevents the human racing live agents.

**Would change the decision**: agents mutating at sub-second frequency (drop
mutations entirely); Ink raw-mode instability (drop $EDITOR).

**Confidence**: High.
