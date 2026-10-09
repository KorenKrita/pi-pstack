# Step 4 independent review

Reviewer: `local-responses/gpt-6-astra` (high), no session context, on range `9ad7095..e7d04c3`.
Fixed in the commit that adds this file. Per the project rule, the fixes are not re-reviewed.

## Disposition

| # | Severity | Finding | Valid | Fix | Regression |
|---|---|---|---|---|---|
| 1 | P1 | `LoopStart` with `/poteto-mode` lets the model enable poteto mode | yes | `LoopStart` rejects prompts that start with `/poteto-mode` or `/skill:poteto-mode`. User `/loop` is unchanged (the user is the grant) | `#1 LoopStart refuses /poteto-mode` |
| 2 | P1 | Loop timers survive reload/session replacement and call a stale ctx | yes | `session_shutdown` marks the runtime disposed and clears timers without stop records (the new runtime restores loops); `fireLoop` also guards the stale-ctx throw | `#2 session_shutdown clears loop timers…` (asserts the stale ctx is never touched) |
| 3 | P1 | Esc does not pause a goal: Pi skips `agent_before_settle` on abort | yes (confirmed in `agent-session.js`: the abort flag skips `_runBeforeSettleBoundary`, `agent_settled` carries `aborted: true`) | `agent_settled` with `aborted` pauses an active goal before notifications and loop ticks are dispatched | `#3 Esc … pauses the goal` |
| 4 | P2 | Goal continuation drops entries earlier handlers proposed | yes (confirmed in `runner.js`: returned `entries` replace) | return `[...event.entries, continuation]` | `#4 goal continuation keeps entries…` |
| 5 | P2 | `/tree` navigation does not rebuild loops | yes | `session_tree` rebuilds live loops from the selected branch (no records written) | `#5 session_tree rebuilds loops…` |
| 6 | P2 | Overdue dynamic deadline fires immediately on resume | yes | an expired deadline counts as missed; the next tick is a full interval (or default) from now | `#6 an overdue dynamic deadline is not replayed` |
| 7 | P2 | Dynamic loop never re-arms if the tick starts no run | yes | every tick arms a fallback wake (default delay); `agent_settled` replaces it with the scheduled delay | `#7 a dynamic tick that starts no run still re-arms` |
| 8 | P2 | Same-millisecond `LoopStart` ids collide | yes | id = time + per-process counter + random suffix | `#8 concurrent LoopStart calls get distinct ids` |

Each regression test was checked to fail with its fix reverted (one failure each).

Verification after fixes: `bun test` 159 pass; `bunx tsc --noEmit`; `bun run check` 0 findings; `bun run sync` no drift; `tests/smoke/step4.sh` 8/8 against real Pi (`local-openai/glm-5.3-flash`).
