# pi-pstack

A Pi port of Cursor's [pstack](https://github.com/cursor/plugins/tree/main/pstack) (poteto-mode playbooks, principles, multi-model panels), plus `deslop`, `control-ui`, and `control-cli` from cursor-team-kit, mechanically adapted to Pi paths. A bundled extension supplies the Cursor built-ins the skills rely on. See [UPSTREAM.md](./UPSTREAM.md) for what is vendored, how it is adapted, and which built-ins are provided.

```sh
pi install git:github.com/KorenKrita/pi-pstack
```

## Activation

pstack is off until you use it. Two states, both stored in the session and restored per branch (fork, resume, tree navigation):

- **pstack active**: the `Task`, `AskQuestion`, and `pstack_config` tools are enabled, and each turn the system prompt gets a short adapter note (Pi model ids, candidate models, session paths, local-only execution) plus your always-applied pstack rules. It turns on when you run `/skill:<name>` for one of this package's skills (a same-named skill from another package does not count), any pstack skill command below, `/pstack on`, or when the agent `read`s one of this package's `SKILL.md` files. Reading a SKILL.md through `bash` is not detected.
- **poteto mode**: only via `/poteto-mode` (or `/skill:poteto-mode`). It adds poteto-mode's reminder and an explicit full-autonomy grant every turn. Your explicit instructions, safety constraints, and AGENTS.md permission/destructive-action rules still take precedence. Other pstack skills never turn it on.

## Commands

| Command | Effect |
| --- | --- |
| `/<skill-name> [args]` | One per pstack skill (e.g. `/how`, `/arena`, `/setup-pstack`). Activates pstack, then submits exactly what `/skill:<name> [args]` would. Skipped with a warning if the name is already taken. |
| `/poteto-mode [args]` | As above, and enables poteto mode. |
| `/pstack on` | Activate pstack (not poteto mode). |
| `/pstack off` | Turn off pstack and poteto mode; removes only this extension's tools from the active set. |
| `/pstack status` | Read-only: state, tools provided, tool/command collisions, config path and validation. |

If another extension already registers `Task` or `AskQuestion`, pstack does not override it and runs without that tool (shown in `/pstack status`).

## Configuration

Run `/setup-pstack` once. It lists your models with configured credentials, asks for a budget (`unlimited`, `large`, `medium`, `small` → Pi thinking levels, clamped to what each model supports), has you choose a model for every role (no defaults: upstream's Cursor slugs are not Pi ids), and writes through the `pstack_config` tool.

- File: `$PSTACK_HOME/rules/pstack-models.mdc`, default `~/.pi/pstack/rules/pstack-models.mdc`. Every `*.mdc` in that `rules/` dir with `alwaysApply: true` is injected while pstack is active.
- Values: `provider/id`, optionally `:<thinking>` (`off|minimal|low|medium|high|xhigh|max`, per model), or `inherit-parent` / `auto` (= the parent chat model).
- `Task` refuses to run until the config is valid (`pstack is not configured: run /setup-pstack` plus the report).

## Subagents (Task)

`Task` runs each subagent as a local `pi --mode json -p` child process that loads only this package (no other extensions, no AGENTS.md/context files, no other skills or prompt templates) and reuses your Pi credentials. The parent's prompt is the child's only brief, so it must carry the constraints that apply.

- **Foreground** (default): the tool call streams progress and returns the child's final assistant message. A non-zero exit, a model error, or an empty reply is a tool error, never a success. Aborting the tool call cancels the child.
- **Background** (`run_in_background: true`): returns a `taskId` at once. Use `TaskStatus` (one task or this session's list), `TaskOutput` (`wait: true` blocks, `timeoutSeconds` default 600), `TaskCancel`. Inspecting never resumes a task. Background children belong to this Pi process and stop when it exits; tasks found running from a dead Pi are marked `error` at the next session start.
- **Resume** (`resume: <taskId>`): continues that child's own Pi session (`--session-dir … -c`) with the new prompt. Refused while the task is running.
- **Types**: `generalPurpose` (default), `explore` (read-only tools), `bash`, `browser` (no built-in browser; told to use control-ui or CLI tools), and the package agents `poteto-agent`, `Comment Sicko` (their body is appended to the child system prompt).
- **`readonly: true`** limits the child to `read, grep, find, ls` (plus pstack tools) and tells it not to write. It is a tool restriction, not a sandbox. A readonly child's own Tasks are readonly too.
- **Nesting**: root chat plus at most 2 subagent levels (coordinator → track → worker). A depth-2 child's `Task` returns a nesting-limit error.
- **`isolation: "worktree"`** (plugin contract): runs the child in `git worktree add $PSTACK_HOME/worktrees/<id> -b pstack/<id>` from the current repo's HEAD; the worktree is kept for you to review and clean up.
- **`environment: "cloud"`** runs locally and the result says so.
- **Concurrency**: unlimited by default. Optional `$PSTACK_HOME/config.json` `{"maxConcurrent": N}` queues extra spawns FIFO (status `queued`).
- **Child command**: the running Pi binary (or `pi` on PATH); `PSTACK_PI_BIN` overrides it (tests use a fake).
- **Store**: `$PSTACK_HOME/tasks/<id>/` holds `meta.json` (status, model, depth, pid, usage, error), `prompt.md`, `system.md`, `output.md`, `events.jsonl` (raw child events), and `session/` (the child's Pi session).

## Status

Provided: activation, commands, prompt injection, `/setup-pstack` with `pstack_config`, `AskQuestion`, and the local `Task` runtime with `TaskStatus` / `TaskOutput` / `TaskCancel`.

Pending (Step 4): completion notifications that wake the parent chat, `/loop`, `/goal`, `create-skill`, the `mcps/` tool listing.

## Development

```sh
bun install
bun run sync        # regenerate skills/ and agents/ from the pinned upstream (never hand-edit them)
bun run check       # validate generated output
bun test            # unit tests (deterministic, temp dirs)
bunx tsc --noEmit
tests/smoke/step2.sh [provider/model]   # real headless Pi; transcripts in tests/smoke/out/ (gitignored)
tests/smoke/step2-forward.sh [provider/model]
tests/smoke/step3.sh [provider/model]   # foreground, background + TaskOutput, resume, nesting limit
```

Tests and the smoke set `PSTACK_HOME` to a temp dir. The smoke does not exercise interactive UI (`AskQuestion`, setup confirmation); the unit tests cover those with a fake UI.
