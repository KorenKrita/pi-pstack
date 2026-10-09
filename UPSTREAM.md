# Upstream

`skills/` and `agents/` are **generated**. Do not edit them by hand; change `scripts/rules.ts` and rerun the sync.

```sh
bun run sync                          # shallow-fetches the pinned commit into .upstream-cache/ (gitignored)
bun run sync -- --upstream /path/to/cursor-plugins   # use a local checkout instead
bun run check                         # validate generated output
```

Input is read from the git tree at the pinned commit (`git ls-tree` / `git cat-file`), never from the working tree, so a dirty checkout cannot change the output; a `--upstream` dir (or cache) that does not contain the pinned commit is rejected. The sync is idempotent (a rerun produces no git diff) and deletes generated files that no longer map to an upstream file. It prints per-rule hit counts.

## Pinned source

- Repo: <https://github.com/cursor/plugins>
- Commit: `fae2c6ed95821bd85f614a73e4842e13229fa5e5` (constant `UPSTREAM_COMMIT` in `scripts/sync.ts`)
- pstack version at that commit: 0.15.5

## Vendored

| Upstream | Output | Notes |
| --- | --- | --- |
| `pstack/skills/*` except `make-bot-ui` | `skills/<name>/` | Whole directories, including `references/`, `playbooks/`, `scripts/` (e.g. `poteto-mode/scripts/orch`, `watch-pr`, `worktree-audit.sh`). File modes preserved. |
| `pstack/agents/*.md` | `agents/` | `poteto-agent`, `Comment Sicko` subagent definitions (consumed by the extension's Task tool later). |
| `cursor-team-kit/skills/{deslop,control-ui,control-cli}` | `skills/<name>/` | pstack routes to these by name ("from `cursor-team-kit`"). |

## Excluded

| Upstream | Why |
| --- | --- |
| `pstack/skills/make-bot-ui` | Builds UI for Cursor Automations webhooks (`api2.cursor.sh/automations/...`); no Pi counterpart. |
| `pstack/automations/` (benny) | Cursor Automations routines (triage / reproduce bots) that run on Cursor's cloud scheduler. No vendored skill references benny, so no rewrite is needed. |
| `pstack/docs/` | Human-facing docs; not needed at runtime. Read them upstream. |
| `pstack/README.md`, `pstack/.cursor-plugin/`, `pstack/assets/` | Cursor plugin packaging and marketing; Pi uses this repo's `package.json`. |
| Rest of `cursor-team-kit` | Not referenced by pstack. |

## Adaptation rules

Applied in order to every vendored text file (binary files are copied verbatim). URLs (`http(s)://...`) are never rewritten. Model defaults in setup-pstack, arena, swarm, and interrogate are adapted to Pi ids and the shared `pstack_config` tool (rules 16–27); other upstream prose is left alone. Hits are at the pinned commit.

| # | id | Find | Replace | Scope | Hits | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `rules-dir` | `~/.cursor/rules/` | `~/.pi/pstack/rules/` | all | 7 | Intermediate rewrite before the file-scoped setup/read rules; the extension loads `$PSTACK_HOME/rules/*.mdc`. |
| 2 | `recall-transcript-layout` | recall's sentence describing `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` and its slug format | Pi layout `~/.pi/agent/sessions/<slug>/<timestamp>_<uuid>.jsonl`, slug `--Users-you-proj--`, Pi session JSONL entries | `skills/recall/SKILL.md` | 1 | Pi's slug is `--` + cwd without leading slash, `/\:` → `-`, + `--` (`session-manager.js`). |
| 3 | `worktree-audit-session-dirs` | comment + `slug=` + `transcripts=` block | `session_dir()` helper computing `~/.pi/agent/sessions/--<path, / and : → ->--`, plus `main_sessions` | `worktree-audit.sh` | 1 | Pi keys sessions by the cwd pi was launched in (`session-manager.js`). |
| 4 | `worktree-audit-scan` | the `if [ -d "$transcripts" ]` / `rg ... "$transcripts"` lines | scan both the main worktree's session dir and the candidate `$wt`'s own session dir | `worktree-audit.sh` | 1 | Chats launched inside a worktree live in that worktree's dir; chats launched in the main repo that operate on it live in the main dir. No global scan across unrelated projects. Covered by `tests/worktree-audit.test.ts`. |
| 5a | `reflect-session-layout` | Cursor's three-layout `ls` + description | `ls -t <session-dir>/*.jsonl`; nested dirs are subagent runs | `skills/reflect/SKILL.md` | 1 | Pi stores one JSONL per session at the top of the session dir. |
| 5b | `reflect-first-user-message` | "read the first JSONL line and check `message.content[0].text`" | skip the `type: "session"` header and events; first `type: "message"` with `role: "user"`; content is a string or parts array; `jq` one-liner | `skills/reflect/SKILL.md` | 1 | Pi's first line is session metadata, not a message. |
| 6 | `transcripts-dir-phrase` | ``the (active )?workspace's `agent-transcripts/` directory`` | ``… Pi session directory `~/.pi/agent/sessions/<slug>/` `` | all | 5 | Same concept; the extension must name this path in the system prompt (see built-ins). |
| 7 | `transcripts-dir-bare` | ``under `agent-transcripts/` `` | ``under the Pi session directory `~/.pi/agent/sessions/<slug>/` `` | all | 1 | orchestrate.md. |
| 8 | `transcripts-placeholder` | `<agent-transcripts>` | `<session-dir>` | all | 0 | Fallback; reflect's only uses are rewritten by 5a. |
| 9 | `projects-dir` | `~/.cursor/projects/` | `~/.pi/agent/sessions/` | all | 5 | "Do not glob across `~/.pi/agent/sessions/*/`" keeps the same privacy guard. |
| 10 | `user-skills-dir` | `~/.cursor/skills/` or `$HOME/.cursor/skills/` | `~/.pi/agent/skills/` (same prefix) | all | 5 | Pi user-level skill dir. |
| 11 | `plugin-paths-phrase` | ``plugin-installed paths under `~/.cursor/plugins/` `` | ``package-installed paths under `~/.pi/agent/git/` `` | all | 3 | Pi checks out `pi install git:...` packages there. |
| 12 | `plugins-dir` | `~/.cursor/plugins/` | `~/.pi/agent/git/` | all | 0 | Fallback for drift. |
| 13 | `subagents-dir` | `~/.cursor/subagents/` | `~/.pi/pstack/subagents/` | all | 0 | Not present at the pinned commit; guards drift. |
| 14 | `workspace-skills-dir` | `.cursor/skills/` bare or after `./`, `../`, `<dir>/` (not after a word char, so `foo.cursor/` is untouched) | `.pi/skills/` | all | 11 | Project skills, incl. `create-verification-skill`'s `verify-<app>` output and automate-me's mode skills. Runs after the `~/` rules so user-level paths are already gone. |
| 15 | `home-cursor-fallback` | `~/.cursor/` or `$HOME/.cursor/` | `~/.pi/pstack/` / `$HOME/.pi/pstack/` | all | 0 | Anything left is pstack-owned state. |
| 16 | `setup-intro` | setup-pstack's opening "Write `~/.pi/pstack/rules/pstack-models.mdc` …" | `$PSTACK_HOME/rules/pstack-models.mdc` (default `~/.pi/pstack/…`) written through `pstack_config` | `skills/setup-pstack/SKILL.md` | 1 | Single config path (`PSTACK_HOME`); the model never picks the path. |
| 17 | `setup-detect-models` | step 1 "Enumerate the model slugs you can pass to a `Task` subagent …" | use the adapter note's candidate list (configured credentials + supported thinking levels); Pi ids `provider/id[:level]`; empty → ask the user to configure a provider | same | 1 | Pi has no Task-probe; the extension lists models in the system prompt. |
| 18 | `setup-load-state` | step 2 "The default role-to-model mapping …" | read via `pstack_config read`; no config → every role needs a choice | same | 1 | Upstream defaults are Cursor slugs (`claude-opus-5-5-max`, …), not Pi ids; no machine-specific mapping and no silent `inherit-parent`. |
| 19 | `setup-apply-budget` | step 3b effort-token ladder on slugs | budget sets the `:<thinking>` suffix: highest supported level ≤ target (`unlimited` = entry's own, default `max`); none → needs a choice; confirm the final mapped table | same | 1 | Pi thinking levels; `pstack_config write` applies the same mapping and refuses unresolved entries. |
| 20 | `setup-confirm-roles` | step 3c "Show every role …" | full table; resolve needs-a-choice per role or per group (code / judgment+prose / reflect tooling / panels), edit panel membership, confirm | same | 1 | Every role starts unset in Pi, so grouping keeps setup short. |
| 21 | `setup-validate` | step 4 "Every real slug written must be in the detected set …" | `pstack_config write` validates (roles present, panels non-empty, model exists with credentials and level) and writes nothing on failure | same | 1 | Same validator as the Task gate. |
| 22 | `setup-write-rule` | step 5 "Write … Shape:" + the slug-filled code block | call `pstack_config write {budget, roles}`; shape shows `<provider>/<id>:<level>` placeholders | same | 1 | The tool serializes the upstream shape; `tests/config.test.ts` checks the shape's role list and header equal `serializeModelsRule`. |
| 23 | `setup-applies-when` | step 6 "applies to new sessions" | applies from the next turn | same | 1 | The extension re-reads always-apply rules every turn. |
| 24 | `arena-runner-config` | arena Phase A runner selection + Cursor slug fallbacks | `pstack_config read` from active home; missing/invalid → setup; Pi ids only | `skills/arena/SKILL.md` | 1 | No hard-coded default-home read or invalid slug fallback. |
| 25 | `arena-judge-config` | arena Phase C cross-judge selection + Cursor slug fallbacks | use validated cross-judge list from Phase A | same | 1 | Shares the same config snapshot. |
| 26 | `swarm-worker-config` | swarm Phase A worker selection + Cursor slug fallback | `pstack_config read` from active home; missing/invalid → setup; Pi ids only | `skills/swarm/SKILL.md` | 1 | No hard-coded default-home read. |
| 27 | `interrogate-reviewer-config` | reviewer panel + Cursor default table and fallback | `pstack_config read`; one reviewer per configured Pi id | `skills/interrogate/SKILL.md` | 1 | No default slug or path silently overrides the user's config. |
| – | `frontmatter-name` | SKILL.md `name:` not a valid Pi name | normalized (`Poteto Mode` → `poteto-mode`) | `SKILL.md` | 1 | Pi requires `[a-z0-9-]`, ≤64, equal to the dir name. Other keys (`disable-model-invocation`, `mode`, `reminder`, `icon`, `color`, `paths`) are untouched for the extension. Agent files keep their display names (`Comment Sicko`), since skills route by that `subagent_type`. |

`bun run check` scans every non-binary generated file (binary = contains a NUL byte) with URLs masked out, and fails on any remaining `~/.cursor`, `$HOME/.cursor`, or `.cursor/` path segment (bare, `./`, `../`, `<dir>/`) unless allowlisted in `CURSOR_ALLOWLIST` (`scripts/rules.ts`):

| File | Text | Reason |
| --- | --- | --- |
| `skills/poteto-mode/playbooks/worktree-cleanup.md` | `.cursor/worktrees/myrepo/x` | Example of a worktree outside the hand-typed guess; the lesson (read `git worktree list`) is tool-independent. |

It also validates skill names/descriptions and that every skill reference resolves — `The/the **x** skill`, bold lists (`**a** and **b** principle skills`), `**principle-x**`, `Use **x** for/whenever/when/to`, and `/x` slash commands (bare, backticked, parenthesised, or quoted; `/tmp` is ignored) — to a vendored skill or to `EXTERNAL_SKILLS` (`create-skill`, `babysit`, `loop`, `goal`).

### Residual Cursor references kept on purpose

- "`cursor-team-kit`" as the source of `deslop`/`control-ui`/`control-cli` (poteto-mode SKILL.md, multi-phase-plan, orchestrate, opening-a-pr). Those skills are vendored here, so the name still resolves; rewording is a later judgment call.
- Prose naming Cursor as the runtime ("Cursor's built-in …", "Cursor restart", "Cursor dashboard", "the Cursor environment"). Listed below as extension work.
- `author === "cursor"` / `cursor_automation_id` in `watch-pr/github.ts` (GitHub bot login for Bugbot comments) and `@cursor-skill/poteto-mode-tools` package name: identifiers, not paths.
- Variables named `cursor` / `endCursor` (GraphQL pagination) in `watch-pr` and `check-plan.mjs`.
- Vendored upstream tests under `skills/poteto-mode/scripts/**/*.test.ts` are not run by this repo (`bunfig.toml` sets `test.root = "./tests"`).

## Cursor built-ins and the extension

Skill text is left as-is except for setup-pstack and the per-role readers (rules 16–27). The extension (`extensions/pstack/index.ts`, pure logic in `config.ts` / `rules.ts`) provides or approximates these:

| Built-in | Status in Pi |
| --- | --- |
| **AskQuestion** tool | Provided. Cursor's schema is not public, so this is a plugin contract: `{ title?, questions: [{ id, prompt, options: [{ id, label }], allow_multiple? }] }` via `ctx.ui.select`; returns selected ids+labels per question, an explicit cancelled result, or (no UI) an error telling the model to ask in plain text. |
| **Task** tool | Provided as local Pi child processes: foreground/background, `resume` (child session continued with `-c`), `subagent_type` (`generalPurpose`, `explore`, `bash`, `browser`, package agents), `model` per role with thinking level, `readonly` (tool restriction, not a sandbox), nesting root + 2, unlimited concurrency with optional `maxConcurrent`. Plugin additions: `isolation: "worktree"` and the `TaskStatus` / `TaskOutput` / `TaskCancel` tools (Cursor's background-agent inspection surface is not public). Background children do not survive the parent Pi process. |
| **setup-pstack writes** | Provided via the `pstack_config` tool (`read` → parsed config + validation report; `write` → apply budget, reject unresolved entries, validate, atomic write in upstream `.mdc` shape). Arena, swarm, and interrogate also read through this tool so `PSTACK_HOME` is consistent. |
| **`~/.pi/pstack/rules/*.mdc` always-applied rules** | Provided: bodies of `$PSTACK_HOME/rules/*.mdc` with `alwaysApply: true` are injected every turn while pstack is active; malformed frontmatter is skipped with a warning. |
| **Session path in system prompt** | Provided in the adapter note (session dir + current session file). |
| **Skill frontmatter `mode` / `reminder`** | Provided: poteto-mode's reminder plus an explicit autonomy grant, only while poteto mode is on (`/poteto-mode`). |
| **Skill frontmatter `paths`** | **Approximation**: after `read`/`edit`/`write` touches a matching file, a one-per-session hint names the skill. Cursor's exact semantics are not reproduced. `icon` / `color` are ignored. |
| **Cloud agents / dashboard / restart semantics** | Not provided: everything runs locally. `environment: "cloud"` runs as a local child and the result carries `environment_note`; no cloud isolation or survive-shutdown guarantee. After a restart, tasks left running are marked `error` ("parent Pi exited before completion"); their sessions can still be resumed. |
| **Background completion notifications** | Provided: a `pstack-task-done` message wakes the idle parent (done/error only; skipped if already read via `TaskOutput`, cancelled, other session, or pstack off); at-least-once within a process, re-sent once after restart. |
| **Bugbot** | External GitHub product; the adapter note says so. |
| **`/loop`**, **`/goal`** commands | Provided as plugin contracts (Cursor's semantics are not public): `/goal` continues normally ended runs until `GoalDone`, pauses on abort/error/blocked; `/loop` sends the prompt unchanged on a fixed or model-scheduled interval, only while Pi runs. Model-facing `GoalSet` / `GoalDone` / `LoopStart` / `LoopStop` / `LoopSchedule`. |
| **Agent store** ("the current agent's store", orchestrate / multi-phase-plan) | Provided: `$PSTACK_HOME/projects/--<cwd>--/`, named in the adapter note with the `orch.ts --store` invocation. |
| **create-skill** skill | Provided as a plugin contract (Cursor's text is not public): `extras/skills/create-skill/SKILL.md`, loaded with the package skills and in Task children. Covers what callers ask of it: pin down job/triggers/placement, draft in Agent Skills format, validate, test in clean `Task` children, iterate, and a description-optimization loop (should/should-not-trigger sets judged by clean children). |
| **`mcps/` directory** / available-tools map (`why`) | Provided: Pi's built-in MCP client is the source. The adapter note lists the MCP servers connected now with their tools and how to reach them (codemode / tool_search). Agent-mode Task children get `-e builtin:mcp -e builtin:codemode` when the parent runs them (same `mcp.json` servers); `readonly` children get none ("readonly strips MCPs"). |
| **babysit** built-in (routed *away* from) | Nothing to provide. |

Known activation gap: pstack activates on `/skill:<name>`, a pstack slash command, `/pstack on`, or a successful `read` tool call on one of this package's `SKILL.md` files. Reading a SKILL.md through `bash` (`cat`, `sed`) is not detected.

Where upstream used these built-ins (for reference):

| Built-in | Used by |
| --- | --- |
| **Task tool** (`subagent_type`, `model`, `readonly`, `run_in_background`, `resume`, `environment: "cloud"`) and subagent types `generalPurpose`, `poteto-agent`, `Comment Sicko` (from `agents/`, incl. `is_background: true`) | `arena`, `how`, `interrogate`, `no-comments`, `reflect` (+ `references/{divergent,judgment,tooling}-reviewer.md`), `setup-pstack`, `swarm`, `why`, `poteto-mode/SKILL.md`, `poteto-mode/playbooks/{multi-phase-plan,opening-a-pr,orchestrate,pause-safely,session-pickup}.md`, `recall` (resume), `agents/poteto-agent.md` |
| **AskQuestion** tool | `automate-me`, `setup-pstack`, `poteto-mode/SKILL.md`, `poteto-mode/playbooks/autonomous-run.md` |
| **`/loop`** command | `poteto-mode/SKILL.md`, `poteto-mode/playbooks/{autonomous-run,autopilot-full,autopilot-stack,babysit,bug-fix,multi-phase-plan,shipping,visual-parity}.md` |
| **`/goal`** command | `poteto-mode/playbooks/{autopilot-full,autopilot-stack,multi-phase-plan}.md`, `poteto-mode/scripts/check-plan.mjs` (plan marker) |
| **create-skill** skill | `automate-me`, `reflect` (+ `references/synthesizer.md`), `poteto-mode/SKILL.md`, `poteto-mode/playbooks/authoring-a-skill.md` |
| **babysit** built-in skill (routed *away* from) | `poteto-mode/SKILL.md`, `poteto-mode/playbooks/babysit.md` |
| **`mcps/` directory** / available-tools map | `why/SKILL.md` |
| **Session path in system prompt** ("the system prompt names the path") | `automate-me`, `reflect`, `show-me-your-work`, `poteto-mode/playbooks/{eval,session-pickup}.md` |
| **Bugbot** (Cursor PR reviewer bot) | `poteto-mode/SKILL.md`, `poteto-mode/references/bugbot-triage.md`, `poteto-mode/playbooks/{autopilot-full,autopilot-stack,babysit,multi-phase-plan}.md`, `reflect/references/synthesizer.md`, `poteto-mode/scripts/watch-pr/github.ts` |
| **Cloud agents / dashboard / restart semantics** | `poteto-mode/SKILL.md`, `poteto-mode/playbooks/{orchestrate,autopilot-full,autopilot-stack,shipping}.md` |
| **Skill frontmatter semantics** `mode`, `reminder`, `icon`, `color` (poteto-mode), `paths` (typescript-best-practices) | respective `SKILL.md` |
| **`$PSTACK_HOME/rules/*.mdc` always-applied rules** (`pstack-models.mdc`) | `setup-pstack` (writes through `pstack_config`), `arena`, `interrogate`, `swarm` (read through `pstack_config`) |

## Attribution

- pstack — MIT © Lauren Tan. See `LICENSE.upstream-pstack`.
- cursor-team-kit (`deslop`, `control-ui`, `control-cli`) — MIT © Cursor. See `LICENSE.upstream-cursor-team-kit`.
