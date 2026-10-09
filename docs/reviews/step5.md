# Step 5 independent review

Reviewer: `local-responses/gpt-6-astra` (high), no session context, on range `63dc17b..219788c`.
Fixes: `5520396` (plugin), `f91ab84` and `575eb23` (plugin, found while verifying the fixes), `c4d94b7` (acceptance drivers), and the commit that adds this file (report).
Per the project rule, the fixes are not re-reviewed.

## Disposition

| # | Severity | Finding | Valid | Fix | Regression |
|---|---|---|---|---|---|
| 1 | P1 | Children ignore the parent's project-trust decision, so a session-only `--approve` parent's `.pi/mcp.json` overrides (a disabled server, project-only servers) do not reach the child | yes; reproduced against real Pi at `e650f29`: the child reached `blocked` and missed `projonly` (`run9-mcp.ts`, 3 FAIL) | `5520396`: the Task passes the caller's `ctx.isProjectTrusted()` to the child as `--approve` / `--no-approve`. Gaps found after it: resume reused the creator's stored decision, and with `isolation: "worktree"` the child's cwd (the worktree) did not hold the parent's `.pi/mcp.json` as the parent sees it — missing when untracked (`575eb23` copied it), the committed version when the parent had uncommitted edits, and stale after a resume (both missed by `575eb23`, fixed in the follow-up commit). Now: resume passes the resuming caller's decision; the worktree's `.pi/mcp.json` mirrors the parent's file (content or absence) on creation and on every resume, kept out of `git status` / `git add -A` (skip-worktree when tracked, a self-ignoring `.pi/.gitignore` when not). Limit: a worktree resumed from a different parent checkout mirrors that caller's cwd | `review 5.1` (args, through Task, resume by an untrusted caller); `review 5.5` ×3 (untracked, uncommitted tracked edit, resume add/remove); `run9-mcp.ts` same-cwd and worktree (see `docs/acceptance/step5.md`) |
| 2 | P1 | A model-authored Task prompt `/poteto-mode …` reaches the child on stdin and is dispatched as a user command, granting poteto | yes | In a Task child (`PSTACK_TASK_ID` set) `/poteto-mode` and `/skill:poteto-mode` never grant poteto (children start active without it) | `review 5.2` (both forms); `run9-mcp.ts` poteto-child checks |
| 3 | P2 | `builtin:mcp` is detected from tools only, so a Task started before a server connects gets no MCP | yes | Also detect from the `/mcp` command source (registered at load) | `review 5.3` |
| 4 | P2 | The MCP inventory lists hidden tools (disabled servers, hidden tools) | yes | Skip `exposure: "hidden"`; wording changed to "reachable tools now" and notes that servers still connecting are not listed | `review 5.4` |
| 5 | P2 | `run5-bg` cancel allows one notification; `/pstack off` does not check notifications; grace windows | yes | Zero notifications for the cancelled and the off task, in events and in persisted entries (matched on `details.taskId`); the no-wake windows start at the `TaskCancel` call / the `/pstack off` command record (record index, no time grace); a missing record or task id is a FAIL; exactly one persisted notification for the woken task | re-run (below) |
| 6 | P2 | `run1` `\bfail\b` accepts green `0 fail` output as red evidence | yes | Red evidence only from history: a commit on the old `src/stats.ts` where `bun test` exits non-zero with `N>0 fail`, followed by a commit that changes `src/stats.ts` | replayed on the `e650f29` run's history (still red→green); re-run |
| 7 | P2 | `run4` does not correlate command and result, accepts `cat src/cli.ts`, never checks the evidence file | yes | Command/result correlated by `toolCallId`; the call must execute (command position, not `cat`/`test -f`) the CLI or the skill's helper with `mean 2 4` and succeed; evidence files written during the run (any location the skill names) must prove stdout `3` and exit 0, as one transcript or split `.stdout`/`.exit` files. The generator check also needs a successful call. Predicates in `verify-checks.ts` | `tests/acceptance-checks.test.ts` (counterexamples incl. `cat …/capture.sh`, `0 fail` output); re-run |

Report audit items:

- `rpc.ts` `_sent` records were written only to disk, so in-memory "no user prompt" checks were vacuous: fixed, the driver's own commands are now in `records`.
- Goal continuation: Pi forwards boundary messages as `entry_appended`; the report's "`display:false` is not streamed" was wrong. `run6-long.ts` now counts `entry_appended` with `pstack-goal-continue`.
- Late goal abort: `waitFor` now accepts a start index and scans already-received records; the goal abort sends the prompt and waits for the bash start from that index.
- Orphan check: `run6-long.ts` now walks the Task child's process tree (`pgrep -P`) before the abort, requires a `sleep 120` in it, and requires every process in it to be gone after; the unscoped `pgrep -f` is gone.
- Loop entry: `op` is `add` (driver fixed).
- Historical results: the `e650f29` results and logs are kept next to the re-run results (`runs/e650f29/` in the acceptance root) and summarized in `docs/acceptance/step5.md`.

## Found by the re-run (not in the review)

A Task prompt that starts with an own skill command (`/poteto-mode …`, `/how …`) ran the child's command handler, which forwards through `sendUserMessage`; in print mode that call lands after the session is disposed (`Extension error … ctx is stale`), so the child exited with no reply and the Task failed. Fixed in `f91ab84`: the Task sends a leading own-skill command as Pi's `/skill:<name> …`, which the child expands directly. Regression: `review 5.2: a leading own skill command …`; real Pi: the child replies and records `poteto: false`.

`/create-verification-skill` at `f91ab84` generated a skill whose `description` was unquoted and contained `: `. Pi's loader rejected the frontmatter (`Nested mappings are not allowed in compact mappings`) and skipped the skill with only a warning, so a fresh session could not find it. The upstream text asks for frontmatter but not for valid YAML. Fixed in `575eb23` by two replayable sync rules (`verify-skill-valid-yaml`, `verify-skill-discovered`): quote or fold the description, and confirm Pi lists the skill before running it. This is guidance to the model, so the re-run is the evidence, not a guarantee.

How each new test was seen failing:

- `review 5.1`–`5.4` (args): run with the fix reverted.
- `review 5.1` resume by an untrusted caller: written before the resume fix, failed on the stored `--approve`.
- `review 5.5` untracked worktree copy: failed with the copy disabled.
- `review 5.5` uncommitted tracked edit and resume add/remove: written after `575eb23`, failed against it, pass with the mirror.
- leading-skill-command test: written before its fix.
- `tests/acceptance-checks.test.ts`: the `echo 'mean 2 4'` and unrelated split-evidence counterexamples failed against the `c4d94b7` predicates.

Verification after fixes: `bun test`, `bunx tsc --noEmit`, `bun run check` (counts in the final commit's message); acceptance re-runs against the installed commits (see `docs/acceptance/step5.md`).
