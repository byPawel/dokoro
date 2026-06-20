# Council: skills system for dokoro + tachibot (how agents write & learn skills)

**Query:** How to write agent skills and make tachibot agents learn them — format, ownership (dokoro vs .claude/skills vs tachibot-mcp), learning loop from experience, solo-dev MVP.

**Pipeline:** Research (grok_search + perplexity_ask fallback) → Debate (grok FOR / kimi AGAINST / gpt synthesis — focus pipeline went async, fallback used) → Reasoning chain (grok criteria → kimi scoring → openai step failed/tool fallback → gemini verdict + final judge) → Resolution consolidated into gemini's final-judge pass.
**Models:** grok, kimi, gpt-5.4, gemini, perplexity. **Confidence: High (9/10).**

## Recommendation — the "middle ground"

1. **`.claude/skills` is the single canonical ACTIVE store.** Global `~/.claude/skills` is the default (solo-dev skills are mostly project-agnostic); `<repo>/.claude/skills` only for repo-bound skills (repo commands, domain vocabulary). SKILL.md open-standard format → portable across 16+ tools.
2. **dokoro owns EVIDENCE + CANDIDATES, never the active store.** New `dokoro_skill_distill` drafts SKILL.md candidates into `<repo>/dokoro/skill-candidates/` from episodic sessions + affective feedback. Frontmatter: `status: candidate`, `triggers`, `exclusions`, `source_sessions`, `scope`.
3. **Promotion is a manual one-way copy** (`dokoro promote-skill <file> --global|--project`). No sync engine, no symlinks, no auto-rewrite of active skills. Human gate = the anti-rot mechanism.
4. **tachibot consumes via progressive disclosure:** planners get a compact manifest (name + description only); stages fetch ≤2 skill bodies on demand; usage outcomes logged back via `dokoro_feedback_record` — closing the learning loop without token bloat.

## Debate summary

- **FOR dokoro-as-owner (grok):** the system that lived the sessions should own derived skills; local distill-from-memory is the differentiator.
- **AGAINST (kimi):** dual stores WILL drift; symlinks break watchers/CI; per-project default fragments global solo-dev knowledge into divergent copies; auto-distillation from single sessions = "over-generalization machine + skill rot factory"; blind prompt injection = "architectural spam"; the obvious design is "a sync engine pretending to be a feature."
- **Resolution:** ownership split — evidence/candidates in dokoro, active skills native, human gate between.

## Risk register

| Risk | Mitigation | Cost of being wrong |
|---|---|---|
| Candidate graveyard (drafts pile up) | Staleness nudge: dokoro prompts review of candidates >14 days old | Low — degrades to manual store |
| Promotion friction stalls the loop | One frictionless CLI command (move + frontmatter cleanup + conflict/backup handling) | Loop stalls silently |
| Manifest picks irrelevant skills | Strict description guidelines in distill; refine descriptions from logged outcomes | Token waste, mild confusion |

Accepted: slight duplication between candidate folder and active store (worth it to avoid two-way sync).

## 2-evening MVP

- **Evening 1 (dokoro):** SKILL.md candidate template; `dokoro_skill_distill` (or CLI `dokoro capture-skill-candidate`) drafting from session summary + feedback + "what went well" note, opens in $EDITOR; `dokoro promote-skill` one-way copy with `--global/--project` and conflict backup. Hand-write 2 seed skills.
- **Evening 2 (tachibot):** `SkillProvider` over native skill dirs (`list()` frontmatter scan, `search()` keyword match, `get()` body); pipeline param `skills: {mode, token_budget, max_bodies}`; inject manifest only; log `skills_considered/used/outcome` to dokoro.

## What would change the decision

- If SKILL.md standard fragments → revisit dokoro-native format with exporters.
- If candidates rot unreviewed for 2+ months → automate harder (auto-expire) or drop distillation and keep manual authoring.

## Related clarification (user question)

tachibot `planner_maker` ≠ dokoro plans. tachibot CREATES plan documents (markdown narrative written into `dokoro/daily/`); dokoro `dokoro_plan_*` TRACKS execution (JSON checklist: create/check/blocker/validate/auto-archive). They connect only via the shared file workspace today; proposed bridge: planner_maker (or the orchestrator) emits `dokoro_plan_create` from the final synthesis so council plans become live-tracked checklists.
