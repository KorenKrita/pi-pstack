---
name: pstack-create-skill
description: Create or substantively edit an Agent Skill (SKILL.md) for Pi, including its structure, frontmatter, supporting files, a test run, and description tuning so it triggers when it should. Use when asked to create, write, draft, or restructure a skill, when pstack-reflect or pstack-automate-me hands off to create-skill, or when a skill did not trigger and its description needs tuning.
---

# pstack-create-skill

pi-pstack's stand-in for Cursor's built-in `create-skill` (the vendored skills' references to `create-skill` point here, as `pstack-create-skill`). Cursor does not publish that skill's text, so this is the plugin's own workflow: draft → validate → test → iterate, plus a description-optimization loop. Callers say which part they need ("draft / test / iterate", "description-optimization loop", "new skill").

## 1. Pin down the skill

Before writing, know:

- **Job**: the one recurring task it does, in a sentence. If it needs "and" twice, it is two skills.
- **Triggers**: 3–5 real requests that should load it, and 2–3 near misses that should not.
- **Home**: an existing skill that should grow instead? Prefer editing it (the caller may already have decided).
- **Placement**:
  - project: `.pi/skills/<name>/SKILL.md` (or `.agents/skills/<name>/`) in the repo;
  - personal: `~/.pi/agent/skills/<name>/SKILL.md` (or `~/.agents/skills/<name>/`);
  - keep an existing skill's directory; a caller's explicit path wins.

Ask only what you cannot find in the repo, the conversation, or the caller's brief.

## 2. Draft

Directory named after the skill; `SKILL.md` starts with YAML frontmatter, then the instructions.

```markdown
---
name: <name>
description: <what it does>. Use when <triggers, in the user's words>.
---

# <Title>

<Direct instructions.>
```

Frontmatter rules (Agent Skills spec as Pi loads it):

- `name`: lowercase a–z, 0–9, `-`; no leading, trailing, or doubled `-`; ≤ 64 chars; same as the directory.
- `description`: one YAML scalar, ≤ 1024 chars, says what the skill does and when to use it. Quote it, or use `description: >-` with indented continuation lines, when it contains `:` followed by a space, `#`, or leading punctuation. A skill without a description is not loaded.
- Optional: `disable-model-invocation: true` (only reachable through `/skill:<name>`), `license`, `compatibility`, `metadata`, `allowed-tools`.

Body:

- Instructions, not essays: imperative steps the agent follows, in the order it follows them. Keep only prose that changes a decision.
- Concrete over general: commands, paths, file names, output shapes.
- Long reference material goes in sibling files (`references/…`, `scripts/…`), linked by relative path; the agent reads them when the step needs them. Relative paths resolve against the skill directory.
- Point at other skills by name instead of restating them.
- Scripts the skill runs live in the skill directory and are invoked by relative path; declare their runtime needs.

## 3. Validate

Check, and fix before testing:

1. Frontmatter parses (`---` fences, YAML scalars), `name` matches the directory and the rules above, `description` is present and ≤ 1024 chars.
2. Every relative path the body mentions exists.
3. Every skill or slash command it names exists (`/skill:<name>` resolves in this Pi).
4. Scripts run (`--help` or a dry run).
5. Pi loads it: start Pi where the skill is discoverable and look for load warnings, or check that `/skill:<name>` exists. After editing during a session, `/reload`.

If the repo ships its own skill validator or checks, run them too.

## 4. Test

Skip only for purely subjective prose skills, and say so.

1. Write 2–3 test prompts from the triggers in step 1, each with what a correct run must produce or do.
2. Run each in a clean context so the conversation you drafted in does not leak in: one `Task` per prompt (`subagent_type: generalPurpose`, agent mode). The child loads only pi-pstack's skills, so in the brief give the absolute path of the new `SKILL.md` and tell it to read and follow that skill for the request; for a project skill, run in the repo.
3. Compare each result against its expectation. Note where the agent misread, skipped, or improvised.

## 5. Iterate

Fix the instruction that caused each miss (a missing step, an ambiguous word, an order problem), then re-run only the failing prompts. Stop when the prompts pass or the remaining misses are model limits, not instructions; report which.

## 6. Description optimization

Use when a skill exists but did not trigger (or triggered when it should not).

1. Collect the failing request and 5–10 more: about half should trigger, half are near misses that should not.
2. For each, ask a clean `Task` (readonly is enough) with only the candidate list: this skill's `name` + `description` and 3–5 neighbouring skills' names + descriptions from the same skill set. Ask which skill, if any, it would load for the request, and why, in one line.
3. Count hits and false hits. Rewrite the description: lead with the concrete job, name the user's words and the situations, and add a "not for …" clause when a neighbour keeps winning. Stay ≤ 1024 chars.
4. Repeat until the should-trigger set passes and the near misses do not, or a round no longer improves; keep the best version.

## Reply

What was created or changed (path), the frontmatter, validation results, test prompts with pass/fail, description iterations if any, and anything left unresolved.
