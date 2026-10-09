# Step 3 independent review

Reviewer: `local-responses/gpt-6-astra` (high), no session context, on commit `7139c90`.
Fixed in the commit that adds this file. Per the project rule, the fixes are not re-reviewed.

## Disposition

| # | Severity | Finding | Valid | Fix | Regression |
|---|---|---|---|---|---|
| 1 | P1 | Orphan reconciliation SIGKILLs a stored pid that may be reused | yes | `reconcileOrphans` only marks tasks `error`; stored pids are never signalled. Orphaned children exit themselves (#2) | `orphans (T5)`: live process at the stored pid gets no signal |
| 2 | P1 | Parent shutdown does not wait for children; crash/SIGKILL leaves them running | yes | `session_shutdown` awaits `cancelAll()` (SIGTERM, SIGKILL after 3s grace, meta settled); children get `PSTACK_OWNER_PID` and `watchParent` exits them within ~2s when the owner dies | `review 2: shutdown waits…` (SIGTERM-ignoring child); manual real-Pi check: parent `kill -9` → child exited within 5s |
| 3 | P1 | `readonly` with `bash`/`explore` types keeps bash | yes | readonly always uses `read, grep, find, ls` (+ pstack tools); `explore` no longer lists bash | `review 3: readonly removes bash for every agent type`, `subagent types…` |
| 4 | P2 | Prompt as argv is parsed as options / `@file` | yes | prompt written to the child's stdin (verified on real Pi 1.1.0: `-p` with no message reads stdin, also with `-c`) | `review 4: prompts go on stdin verbatim…`; smoke `dash-leading prompt is delivered` |
| 5 | P2 | Resume keeps stale depth/parent and bypasses the nesting limit | yes | resume recomputes `depth` and `parentTaskId` from the caller | `review 5: resume recomputes depth and parent…` |
| 6 | P2 | Wait/cancel silently fail for tasks owned by another runner | yes | `TaskOutput wait` polls the store for non-owned tasks; `TaskCancel` errors with the owner pid and parent task instead of "not running" (cross-process IPC cancel not added) | `review 6: tasks owned by another process…` |
| 7 | P2 | Queued background task reported as running | yes | response built from stored status | `review 7: a queued background task is reported as queued` |

Each regression test was checked to fail with its fix reverted (R1, R2, R5, R6, R7: 1 failure each; R3: 2).

Verification after fixes: `bun test` 126 pass; `bunx tsc --noEmit`; `bun run check` 0 findings; `bun run sync` no drift; `tests/smoke/step3.sh` 8/8 against real Pi 1.1.0 (`local-openai/glm-5.3-flash`).

## Reviewer findings (verbatim)

## Findings

All seven findings below are introduced by **7139c90**.

### 1. P1 — Orphan reconciliation can kill an unrelated process
**Location:** `extensions/pstack/task-runner.ts:144–147`

After an unclean exit or reboot, a stored child PID can be reused by another process. Reconciliation checks only whether that PID exists, then sends `SIGKILL`; it never verifies that the process is still the recorded child.

**Evidence:** An in-memory probe with a dead owner PID and a live, reused child PID recorded:
```text
kill(ownerPid, 0)
kill(childPid, 0)
kill(childPid, "SIGKILL")
```
This can terminate an unrelated editor, server, or other same-user process and lose data.

**Fix:** Do not signal processes identified only by persisted PIDs. Verify process identity using a recorded start time/boot identity or a supervised process handle; otherwise only mark the task orphaned. Add a PID-reuse regression test.

### 2. P1 — Parent shutdown does not reliably terminate its children
**Location:** `extensions/pstack/index.ts:513`; `extensions/pstack/task-runner.ts:298–300, 319–321`

The shutdown handler calls synchronous `cancelAll()`, which sends `SIGTERM` and schedules an unreferenced five-second escalation, but does not await termination. Pi 1.1.0’s interactive shutdown explicitly calls `process.exit()` after extension shutdown handlers finish, so that escalation disappears with the parent. A child that delays or ignores termination can survive. A parent crash or `SIGKILL` bypasses the handler entirely; no parent-death supervision exists.

**Evidence:** The shutdown probe returned with the child still alive, metadata still `running`, and only `SIGTERM` recorded. The installed Pi shutdown implementation confirms it does not wait beyond the returned handler promise.

**Fix:** Make shutdown await bounded cancellation of all children, including escalation and metadata settlement. Add parent-death supervision and process-tree cleanup for abnormal exits. Test quitting with an unresponsive child and terminating the parent unexpectedly.

### 3. P1 — Explicit readonly Tasks can regain unrestricted bash
**Location:** `extensions/pstack/task-runner.ts:197–198`

With `readonly: true`, the builder adds `bash` whenever the selected agent type includes it. Consequently both:
```json
{"readonly": true, "subagent_type": "bash"}
{"readonly": true, "subagent_type": "explore"}
```
receive bash. A readonly child can also delegate to either type and regain it despite inherited readonly enforcement.

**Evidence:** Calling the actual argument builder produced:
```text
read,grep,find,ls,bash,Task,TaskStatus,TaskOutput,TaskCancel,AskQuestion,pstack_config
```

This violates the promised **tool restriction**, independently of whether readonly is a sandbox.

**Fix:** Make explicit and inherited readonly restrictions override agent-type tool lists. Distinguish that restriction from the ordinary `explore` profile’s instruction-only allowance for read-only shell commands. Test readonly against every built-in type and nested delegation.

### 4. P2 — Prompts are parsed as CLI options or file attachments
**Location:** `extensions/pstack/task-runner.ts:199–200`

The prompt is appended directly to argv without literal-input handling. Valid briefs beginning with a Markdown bullet are rejected, and prompts beginning with `@` are interpreted as file attachments rather than passed verbatim.

**Evidence:** Passing generated arguments through the installed Pi 1.1.0 parser produced:
- `- Review src/index.ts\n- Do not edit files` → `Unknown option`, no message.
- `@src/index.ts` → `fileArgs: ["src/index.ts"]`, no message.
- `--help` → help mode, no message.

The fake Pi fixture always treats the last argument as a prompt, so it masks this incompatibility.

**Fix:** Use a literal prompt transport, such as stdin, rather than raw positional argv. Terminating option parsing with `--` addresses leading dashes but is **not sufficient for `@`**, which Pi still interprets as a file argument. Add tests against Pi’s real parser.

### 5. P2 — Resume preserves stale depth and bypasses the nesting limit
**Location:** `extensions/pstack/index.ts:445–446`

Resume copies the previous task’s `depth` and `parentTaskId`, although the limit check uses the current caller’s depth. A depth-1 subagent can resume a completed task originally launched by the root; the resumed process still advertises depth 1 and can launch another worker. The actual process chain then exceeds root plus two levels.

**Evidence:** Resuming a root-created task from a depth-1 caller produced:
```json
{"childDepth":"1","parentTaskId":""}
```
The expected values were depth 2 and the current caller’s task ID.

**Fix:** Recompute runtime depth and parent identity for every launch, including resume, or reject cross-parent resumes explicitly. Add a cross-depth resume test; the existing depth tests cover only fresh spawns.

### 6. P2 — Wait and cancel silently fail for tasks owned by another runner
**Location:** `extensions/pstack/index.ts:338–339, 377–379`

Task lookup is store-wide, but waiting and cancellation consult only the current process’s in-memory runner. For example, the root can inspect a grandchild’s ID with `TaskStatus`, but cannot wait for or cancel it. The same inconsistency occurs between two Pi processes sharing `PSTACK_HOME`.

**Evidence:** A second runner inspecting a live stored task returned:
```text
TaskOutput(wait: true): Still running.
TaskCancel: Task … is not running (status running).
```
Waiting returned immediately, and cancellation did nothing.

**Fix:** Poll persisted status for non-owned waits and route cancellation to the owning process through local IPC or verified process supervision. At minimum, return an explicit ownership error rather than falsely claiming that a live task is not running. Add two-runner tests.

### 7. P2 — Queued background tasks are reported as running
**Location:** `extensions/pstack/index.ts:487–489`

The background response hard-codes `running` in both content and details, regardless of the state selected by `TaskRunner.start()`.

**Evidence:** With `maxConcurrent: 1` and one occupied slot, the second launch returned:
```json
{"returned":"running","stored":"queued"}
```
This breaks the queue/status contract and misleads callers about whether work has started. The existing queue test checks metadata but not the launch response.

**Fix:** Build the response from the post-start metadata and return `queued` when appropriate. Assert both returned and persisted states in the concurrency test.

## Checks and coverage

- Read the Step 3 spec, Step 2 handoff, complete commit diff, named Task-using skills and agents, tests, and relevant installed Pi 1.1.0 implementations.
- **Passed:** `bunx --no-install tsc --noEmit`.
- **Passed:** `bun run check` — 126 files, 49 skills, zero findings.
- **Passed:** 45 read-only tests: 11 rules tests and 34 config tests; the filesystem-writing config test was excluded.
- **Passed:** `git diff --check f7a981e..7139c90`.
- Ran real-parser probes and in-memory dependency-substituted runtime probes. No probe directories were created; the working tree remains unchanged.
- Inspected existing Step 3 smoke transcripts, but did **not** rerun the full suite or smoke scripts because they create files, contrary to this review’s read-only constraint.

The config gate remains covered by passing tests. Activation, ownership-aware `/pstack off`, and prompt injection were reviewed statically without identifying another regression. Real OS cleanup, simultaneous multi-process resume races, and worktree failure recovery remain unverified.
