# Step 5 acceptance: real Pi, Git install

Date: 2026-10-09. Package commits under test: `e650f293573bed20817e614703f154b8afb33e1a` for the first full run, then `f91ab84` and `c4d94b7` for the re-runs after the review (each installed with `pi install` / `pi update --extensions` from `git:github.com/KorenKrita/pi-pstack`; `git rev-parse HEAD` in the installed clone checked). Pi `1.1.0`, Bun `1.4.2`, macOS arm64.

## Environment

- Fresh `ACC_ROOT=$(mktemp -d)` (mode 700). `PI_CODING_AGENT_DIR=$ACC_ROOT/agent` with only `settings.json` (default model + the package) and a `models.json` holding one provider (`local-openai`) with three models: `glm-5.3-flash`, `deepseek-v4-flash`, `gemini-3.8-flash` (mode 600, not copied here). `PSTACK_HOME=$ACC_ROOT/home`.
- `HOME=$ACC_ROOT/fakehome`, so user-level `~/.agents/skills` cannot leak in. PATH lists node, bun and pi explicitly.
- No `-e`, no `--skill`: everything loads from the installed package.
- Inventory check (`get_commands`): 50 skill commands, all from the installed clone; the only other commands are Pi builtins (`llama`, `mcp`).
- Drivers: [`drivers/`](drivers/) — `rpc.ts` runs `pi --mode rpc`, answers `extension_ui_request` dialogs from a script, and logs every record. Assertions read the event stream, session entries, Task records under `$PSTACK_HOME/tasks/`, git history and test runs; none trust model prose alone.
- All models are from one provider. Two different model ids were exercised (arena, interrogate); cross-provider routing was not.

## Results

First run, against `e650f29`: 108 assertions, 100 PASS, 8 FAIL. All 8 FAILs were driver mistakes (wrong field values, or a check against the wrong process); each was re-checked against the artifacts, see [Driver FAILs](#driver-fails). That run found no plugin bug. The independent review and the re-runs after it did find plugin bugs; see [Re-runs after the step 5 review](#re-runs-after-the-step-5-review). The table below is the `e650f29` run.

| # | Scenario | Key evidence | Result |
|---|---|---|---|
| 0 | Missing config | `Task` before setup → tool error "pstack is not configured: run /setup-pstack … config file does not exist"; no new task dir | PASS |
| 0 | `/setup-pstack` | RPC answered 9 real dialogs (budget, per-role picks); tools in order `pstack_config` read → `AskQuestion` ×2 → `pstack_config` write; no `Task` call; rule file parses, every role set, no unknown or duplicate lines; `arena runners` = glm + deepseek | PASS |
| 1 | `/poteto-mode` small bug (`mean` drops the last element) | `pstack-state {active, poteto: true}` entry; commits `test: reproduce mean dropping the last element` (red: `bun test` fails at that commit) → `fix: include the last element in mean's sum`; final `bun test` green; `mean` = 2, 3, 5; no push | PASS |
| 2 | `/arena` (median) | 3 background candidates + 1 cross-judge; Task records show `local-openai/glm-5.3-flash` and `local-openai/deepseek-v4-flash`; all `done`; the applied `median` works. The parent placed the candidates in its own scratch dirs (`/tmp/arena-median/candidate-N/`, outside `ACC_ROOT`), not plugin worktrees | PASS |
| 3 | `/swarm 3` | 3 Task records, all on the configured swarm model, all `done`; all three started within 7 ms and ran 7–8 s each, overlapping; 3 helpers integrated, 17 tests pass | PASS |
| 4 | `/create-verification-skill` on a CLI fixture | `.pi/skills/verify-calc-fixture/SKILL.md` (frontmatter name = dir, has description; Launch/Doctor/Drive/Evidence/Cleanup), `features/{README,mean,error-path}.md`, `helpers/drive.sh`; generator drove the CLI once; a fresh session with `--approve` lists `skill:verify-calc-fixture`, runs `drive.sh mean 2 4`, and writes evidence under `.pi/evidence/` | PASS |
| 5 | Background Task wake | the parent settles while the task is `running`; at completion a new `agent_start` arrives with no prompt sent; exactly 1 `pstack-task-done` message carrying the result; order: settle < task end (+29 s) < wake (+4 ms) | PASS |
| 5 | Resume | `Task {resume: id}` → same record, `runs=2`, `done`; same child session file before and after; child answered `BG-DONE-1-AGAIN`; no extra notification | PASS |
| 5 | Cancel | `TaskCancel` → record `cancelled`, child pid gone, no wake in the next 75 s, no completion message | PASS |
| 5 | `/pstack off` while a background task runs | task finished (`done`); no wake in the next 60 s | PASS |
| 6 | `/loop 30s` | 3 ticks in 100 s, each ran its prompt (`ticks.txt`); loop `add` entry in the session | PASS |
| 6 | Process restart | process closed with the loop active; a new process on the same session file fires ticks again (2 in 70 s) | PASS |
| 6 | `/loop stop` | 0 ticks in the next 70 s | PASS |
| 6 | `/goal` (3 files, one per turn) | 3 runs without user input; session file holds 2 `pstack-goal-continue` messages; `GoalDone` called; goal entries `active → done` | PASS |
| 6b | Goal + RPC abort | abort while the goal's `sleep 90` bash runs → goal `paused` ("the run was aborted"); no `agent_start` in the next 8 s; the bash process is gone; `/goal resume` → `final.txt` exists, goal `done` | PASS |
| 6 | RPC abort during a foreground Task | record `cancelled`, child pi pid gone | PASS |
| 6 | Wrong model in config | `swarm workers: local-openai/no-such-model` → Task error names the role and the model, lists available models; no task created | PASS |
| 7 | `/interrogate` HEAD | `pstack_config read`; 2 reviewers (one per configured entry) on deepseek and glm, both `done`; report has "Act on" / "Consider" | PASS |
| 7 | `/reflect` | 3 lens reviewers + synthesizer, all agent mode (`readonly: false`), all `done`; reviewers got this session's own transcript path; Accepted / Rejected / Backlog output; edits applied after `AskQuestion` (see note) | PASS |
| 7 | `/maintain-verification-skill` | one Task per feature (2); 5 live drives; outcome `changed`, committed on local branch `maintain-verify-calc-fixture`; no push or PR | PASS |
| 7 | Orchestrate (poteto-mode, two units) | `orch.ts` CLI used against `$PSTACK_HOME/projects/<workspace>/orchestrate/calc-fixture/` (`frontier.json`, `decisions.tsv`, …); 2 depth-1 Tasks `done`; both units integrated, 8 tests pass | PASS |
| 7 | `/create-skill` (release-notes) | `.pi/skills/release-notes/SKILL.md` with name and description; tested in 3 clean `Task` children (two runs plus one re-test after an iteration) whose briefs name the new SKILL.md | PASS |
| 8 | `Task` with `isolation: "worktree"` | record `worktree = {$PSTACK_HOME/worktrees/<id>, pstack/<id>}`; child cwd = worktree; child's commit `wt: add marker` on `pstack/<id>`; parent still on `main`, clean, no new file; worktree kept (`git worktree list`) | PASS |

### Re-runs after the step 5 review

The review ([`docs/reviews/step5.md`](../reviews/step5.md)) made the drivers stricter and found plugin bugs. The affected drivers were re-run, each against the commit installed with `pi update --extensions` (HEAD of the installed clone checked). Counts are per commit and are not added to the 108 above.

| Commit | Driver | Result | Notes |
|---|---|---|---|
| `e650f29` | `run9-mcp.ts` (MCP parity, new) | 3 FAIL | Reproduced review 5.1: the child connected `blocked` (disabled by the project) and missed `projonly` |
| `f91ab84` | `run1-poteto.ts` | 7/7 | Red commit proven from history (`bun test` exits non-zero with `N>0 fail` on the old code) |
| `f91ab84` | `run5-bg.ts` | 20/20 | Earlier window checks (from the prompt settling); superseded by the `c4d94b7` row |
| `f91ab84` | `run6-long.ts` | 17/17 | Goal continuation counted from `entry_appended`; abort during the goal's bash; Task child's process tree gone. Ran in parallel with `run5`; its wrong-config step rewrites the shared model rule, so the two should run serially (the `c4d94b7` `run5` ran alone) |
| `f91ab84` | `run9-mcp.ts` | 8/8 | Same cwd: the child reaches `allowed` + `projonly`, not `blocked`; a model-authored `/poteto-mode` Task prompt does not grant poteto |
| `f91ab84` | `run4-verify.ts` | 5/8 | Plugin bug: the generated skill's unquoted `description` contained `: `, Pi skipped it (`Nested mappings are not allowed in compact mappings`). The other 2 FAILs were the driver assuming the earlier evidence layout. Fixed in `575eb23` (sync rules) and `c4d94b7` (driver) |
| `c4d94b7` | `run4-verify.ts` | 8/8 | New skill `verify-calc-fixture` with a folded `description: >`; fresh session discovers it, runs `bun src/cli.ts mean 2 4` successfully, and evidence written by the run proves stdout `3`, exit 0 |
| `c4d94b7` | `run9-mcp.ts` | 11/11 | Adds `isolation: "worktree"`: the worktree holds a copy of the parent's untracked `.pi/mcp.json`; the child called only `mcp__allowed__ping` and `mcp__projonly__ping` |
| `c4d94b7` | `run5-bg.ts` | 20/20 | No-wake windows start at the `TaskCancel` / `/pstack off` record; notifications matched on `details.taskId` |
| `206bea8` | `run9-mcp.ts` | 11/11 | Worktree MCP mirror (`2bea903`): same results as `c4d94b7` with the mirror in place |
| `206bea8` | `run4-verify.ts` | 6/8 as run; 8/8 on replay | The new skill (`verify-calc`, quoted description) was discovered; the fresh session drove `mean 2 4` through the skill's own `run-case.sh` (not under `helpers/`), writing `artifacts/mean/two-value.txt` with `3` and `exit=0`. The driver's predicates only knew `helpers/*.sh` and `exit:`; widened to any `.sh` inside the generated skill and `exit=`, with unit counterexamples, then replayed on this run's events and files (8/8) and on the `c4d94b7` run (still 8/8). Not re-run with a model |

Every driver now exits non-zero on any FAIL. Covered by unit tests only, not by a real-Pi run: resume under a less-trusted caller (`review 5.1`), the worktree mirror of an uncommitted edit to a tracked `.pi/mcp.json` and its refresh on resume (`review 5.5`). Since `2bea903` the worktree copy stays out of `git status` and `git add -A` (skip-worktree when tracked, a self-ignoring `.pi/.gitignore` when untracked); the `c4d94b7` run still showed it as `?? .pi/`.

### Driver FAILs

| Assertion | Why it failed | Re-check |
|---|---|---|
| arena: all Tasks completed | driver expected status `completed`; the enum is `done` | all 4 records `done` |
| verify: fresh session discovers the project skill | first run had no project trust; Pi only loads `.pi/skills` from trusted projects (documented in `docs/security.md`) | re-run with `--approve`: discovered and executed |
| loop: start recorded | driver looked for op `start`; the entry op is `add` | `add` entry present |
| goal: goal-continue messages | the driver read only message events; Pi forwards these boundary messages as `entry_appended`, which it did not count | the session file holds 2; the `f91ab84` re-run counts `entry_appended` (17/17) |
| goal: RPC abort pauses the goal | abort was sent 78 s after the goal had already reached `done` | 6b repeats it with the abort during the goal's bash: PASS |
| abort: no orphan `sleep 120` | `pgrep -f "sleep 120"` matched an unrelated 17-day-old watch loop on the host | the victim's pid is gone; 6b scopes the check to its own marker and passes |
| reflect: no cross-workspace glob | the regex matched the `oldText` of an edit that quotes the skill's own "Do not glob across `…/sessions/*/`" line | no read/bash/find used a glob |
| reflect: Accepted/Rejected/Backlog | the check read only the last assistant message (an edit summary) | an earlier message holds the `## Accepted` / `## Rejected` / `## Backlog` sections |

### Note on `/reflect`

Reflect works as upstream designed: after `AskQuestion` (the driver picked "Apply all"), it edited the skill files it reviewed. Here those were the **installed package's** `skills/reflect/*` (diff kept as an artifact; the clone was reverted after the run). Edits like these are overwritten by the next `pi update` or `bun run sync`. Upstream pstack has the same property for its plugin skills. pi-pstack keeps it unchanged.

## Not verified

- Interactive TUI: no keyboard Esc (aborts went through RPC `abort`), no TUI rendering of notifications or widgets.
- Cross-provider routing (only one provider was configured).
- `/reload` and `switch_session` within one process; the process-restart path was tested instead.
- Machine sleep or shutdown during a background Task (local processes; no remote VM by design).
- Linux (the worktree-audit test still depends on macOS `stat -f`).
- `/swarm` choosing worktree isolation on its own (item 8 requested `isolation: "worktree"` explicitly; arena candidates went to model-made scratch dirs).
- Quality of the upstream playbooks on real repos beyond these fixtures. This run checks mechanics and artifacts, not how good the model's work is.
