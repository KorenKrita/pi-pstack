---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `$PSTACK_HOME/rules/pstack-models.mdc` (default `~/.pi/pstack/rules/pstack-models.mdc`) through the `pstack_config` tool: an always-applied rule that sets pstack's model per role.

## Steps

### 1. Detect available models

Use the candidate model list in the pstack adapter note of the system prompt: models with configured credentials in Pi, each with its supported thinking levels. That is the dependable source; do not call `Task` to probe. If the list is empty, ask the user to configure a provider in Pi (log in to a subscription, set an API key, or add a custom provider in `~/.pi/agent/models.json`) and stop. Never write a model id that is not in that list. Values are Pi ids `provider/id` with an optional `:<thinking>` suffix. The aliases `inherit-parent` and `auto` are always valid even though they are not listed models.

### 2. Load current state

Call the `pstack_config` tool with `action: "read"`. It returns the config path (`$PSTACK_HOME/rules/pstack-models.mdc`, default `~/.pi/pstack/rules/pstack-models.mdc`), the parsed `budget` and role values, and a validation report. If the file exists, treat its `# budget` line and its role values as the current choices. Otherwise every role in step 5 starts as needing a choice: pstack ships no default models for Pi, and `inherit-parent` is never assumed silently. A line whose role is not in step 5, such as `how critics`, is from a retired role (the report lists it as unknown). Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer AskQuestion over free text. Offer these four options with these exact labels, and name the current budget when the rule records one.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the current choices of step 2; roles without a value stay as needing a choice. On a re-run keep every role's model, list, or alias (`inherit-parent`, `auto`). The budget sets the `:<thinking>` suffix of every real model, panel entries included: `unlimited` keeps each entry's own level (`max` when it has none), and `large`, `medium`, and `small` target `xhigh`, `high`, and `medium`. The ladder is `max` > `xhigh` > `high` > `medium` > `low` > `minimal`. Use the highest level in that model's supported list (adapter note) at or below the target; a model that supports only `off` is written without a suffix. If no supported level is at or below the target, mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `small` turns `<provider>/<id>:max` into `<provider>/<id>:medium`, and under `unlimited` a model whose levels stop at `high` gets `:high`. The `pstack_config` write tool applies this mapping too; show and confirm this final mapped table, not the unmapped choices, before calling write. Resolve every needs-a-choice role first: write rejects unmappable entries without changing the file.

**(c) Show the roles and confirm.** Show the full table: every role with its value, marking each role that needs a choice and any model not in the adapter-note list. Also list each line step 2 dropped. While any role needs a choice, ask for it, per role or per group: code roles (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `how explorer`, `why investigators`, `swarm workers`), judgment and prose roles (`judgment and prose`, `hardest tasks`, `how explainer`, `why synthesizer`, `reflect judgment, divergent, synthesizer`), reflect tooling (`reflect tooling`), and panels (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`), where the user also edits panel membership (add, remove, or replace entries). Offer the listed models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model) as the options. Then show the full table again and ask whether to accept it as-is or change specific roles. Prefer AskQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

`pstack_config` `write` validates before writing: every role in step 5 present, panel lists non-empty, and each value `inherit-parent`, `auto`, or a `provider/id[:level]` that exists in Pi with configured credentials and supports that level. `inherit-parent` and `auto` always pass. If it rejects the config, nothing is written: show the report, ask again for the failing roles, and retry.

### 5. Write the rule

After the user confirms the fully mapped table, call the `pstack_config` tool with `action: "write"`, the chosen `budget` name (`unlimited`, `large`, `medium`, or `small`), and `roles`: every role below mapped to its value, as a list of strings for the four panel roles. Do not write the file by hand: the tool picks the path (`$PSTACK_HOME/rules/pstack-models.mdc`, default `~/.pi/pstack/rules/pstack-models.mdc`) and overwrites the whole file atomically, so re-runs stay idempotent. The file has `alwaysApply: true`, a `# budget` line with the chosen budget and its target level, and one line per role, using the same labels poteto-mode uses. Shape (values are placeholders):

```
---
description: pstack per-role model choices (overrides skill defaults)
alwaysApply: true
---
# pstack model configuration. One line per role. Every role is required; re-run /setup-pstack to change it.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.
# budget: unlimited (max)
feature, refactoring: <provider>/<id>:<level>
bug-fix: <provider>/<id>:<level>
perf-issue: <provider>/<id>:<level>
hillclimb: <provider>/<id>:<level>
judgment and prose: <provider>/<id>:<level>
hardest tasks: <provider>/<id>:<level>
how explorer: <provider>/<id>:<level>
how explainer: <provider>/<id>:<level>
why investigators: <provider>/<id>:<level>
why synthesizer: <provider>/<id>:<level>
reflect tooling: <provider>/<id>:<level>
reflect judgment, divergent, synthesizer: <provider>/<id>:<level>
arena runners: <provider>/<id>:<level>, <provider>/<id>:<level>, inherit-parent
arena cross-judge pool: <provider>/<id>:<level>, <provider>/<id>:<level>
swarm workers: <provider>/<id>:<level>
architect runners: <provider>/<id>:<level>, <provider>/<id>:<level>, <provider>/<id>:<level>
interrogate reviewers: <provider>/<id>:<level>, <provider>/<id>:<level>, <provider>/<id>:<level>
```

### 6. Confirm

Tell the user the rule was written (the path `pstack_config` returned) and that it applies from the next turn, since pstack injects always-applied rules on every turn while active. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.
