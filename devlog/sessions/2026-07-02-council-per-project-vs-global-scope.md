# Council: dokoro scope — per-project vs all-projects

**Date**: 2026-07-02
**Query**: Should dokoro stay strictly per-project or gain an all-projects/global
layer (registry, cross-project browse/search)? Does it change the browse gaps
roadmap?
**Pipeline**: Research → Debate (parallel fallback) → 3-thought reasoning chain
(stress-test → risk analysis → verdict) → gemini judge resolution
**Models**: grok (search, FOR, stress-test), perplexity (research), kimi
(AGAINST), gpt-5.4 (synthesis), gemini (verdict + judge)
**Fallbacks**: perplexity_research unavailable; focus orchestrator broken;
openai risk-analysis step misfired (folded into the verdict step)

## Grounding (code facts)

- `DOKORO_PATH = env override || <cwd>/dokoro`; all runtime data in
  `<dokoroPath>/.dokoro` (canonical dir merged in b6e07b4).
- No registry, no cross-project surface anywhere. `search_dokoros` /
  `list_recent_dokoros` search entries WITHIN one workspace despite the names.
- Identity = directory path; worktrees/copies silently fork memory.

## Debate

- FOR (grok): thin `~/.dokoro` address-book registry + `browse --all` +
  cross-project recall; per-project-only is a "coordination tax".
- AGAINST (kimi): registries rot (moved/deleted repos, CI sandbox pollution,
  multi-machine divergence); cross-project reads leak context between client
  projects and blur MCP permission boundaries; no clean identity anchor
  (path/remote/generated-id all fail somewhere); `cd`/`DOKORO_PATH` already
  covers real needs.
- SYNTHESIS (gpt-5.4): make isolation the invariant now; hedge with generated
  `workspace_id` + structured `--json` workspace block; defer registry/reads.
- STRESS-TEST (grok): even the hedge violates YAGNI — dead schema right after
  a data-dir migration; `--json` metadata leaks an internal concept with no
  consumer.

## Decision: Variant A — pure invariant, build nothing extra (confidence: High)

1. **Per-project isolation is the permanent semantic model.** Cross-project
   writes are forbidden, forever.
2. **No workspace_id, no registry, no schema change now.** Retrofit path if
   ever needed: lazy-init an id on first read (one-liner).
3. **`browse --json` v1 ships flat** with the `dokoroPath` string it already
   has — we own the v1 contract; future multi-project output appends fields
   (or versions) rather than nesting now.
4. **Ephemeral sandboxes / tachibot pairing**: pass the project path
   explicitly; never depend on a registry; temp paths must not become durable
   assumptions.

**Explicitly rejected**: user-level workspace registry, `browse --all`,
cross-project recall/search/dashboards, auto-discovery (home/git scanning),
git-remote-based workspace merging, cross-project memory moves/dedupe, any
cloud-sync framing.

**Gaps-roadmap impact**: none structural — the 10-task browse gap plan stays
single-project as drafted (`--json` already flat with `dokoroPath`;
jump-to-category stays workspace-local). Docs should state "browse is scoped
to the active workspace."

**Would flip this decision**: a concrete consumer (e.g. tachibot) requiring
cross-project correlation today; multi-workspace UX becoming a validated user
demand rather than a speculative convenience.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Future --json shape change breaks scripts | M | M | append fields, never repurpose; version only if needed |
| ID retrofit needed later | L | L | lazy-init on first read |
| User friction from strict isolation | L | L | document explicit-path workflow |
