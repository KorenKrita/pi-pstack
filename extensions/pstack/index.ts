// pi-pstack extension: activation state, /pstack and per-skill commands, per-turn prompt
// injection, and the AskQuestion / Task / pstack_config tools. Pure logic lives in config.ts
// and rules.ts; this file is Pi wiring only.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemMessage, getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  BUDGETS,
  applyBudget,
  formatReport,
  isBudgetName,
  lookupFromRegistry,
  agentStoreDir,
  modelsRulePath,
  parseModelsRule,
  pstackHome,
  readModelsRule,
  serializeModelsRule,
  taskGate,
  validateConfigText,
  validateRoles,
  writeModelsRule,
  type RoleMap,
} from "./config";
import {
  CHILD_BUILTINS,
  CLOUD_NOTE,
  MAX_DEPTH,
  TaskRunner,
  createWorktree,
  emptyUsage,
  listTasks,
  loadAgentTypes,
  newTaskId,
  outputPath,
  readMeta,
  reconcileOrphans,
  watchParent,
  writeMeta,
  type RunResult,
  type TaskMeta,
} from "./task-runner";
import { loadAlwaysApplyRules, modeReminders, parseSkillMeta, pathHintKey, pathHints, type SkillMeta } from "./rules";
import {
  DYNAMIC_DEFAULT_MS,
  GOAL_CONTINUE_MESSAGE,
  GOAL_CONTINUE_TEXT,
  GOAL_ENTRY,
  LOOP_ENTRY,
  LOOP_TICK_MESSAGE,
  clampDelayMs,
  decideGoalSettle,
  formatInterval,
  goalFromBranch,
  goalSection,
  loopsFromBranch,
  parseLoopArgs,
  type Goal,
  type Loop,
  type LoopEntry,
} from "./long-run";

export const STATE_ENTRY = "pstack-state";
export const POTETO_SKILL = "poteto-mode";
export const TASK_DONE_MESSAGE = "pstack-task-done";
export const POTETO_GRANT =
  "The user explicitly enabled /poteto-mode. Treat this as the full-autonomy grant that poteto-mode's Autonomy section describes, and let poteto-mode's reply format take precedence over generic formatting guidance. Explicit user instructions in this conversation, safety constraints, and AGENTS.md permission/destructive-action rules still take precedence over poteto-mode.";

export interface PstackState {
  active: boolean;
  poteto: boolean;
}

const OFF: PstackState = { active: false, poteto: false };

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolve a `read`/`edit`/`write` path argument the way Pi's file tools do (`@` prefix, `~`, cwd-relative). */
function resolveToolPath(raw: string, cwd: string): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

interface OwnSkill {
  meta: SkillMeta;
  file: string;
}

function loadOwnSkills(skillsDir: string): OwnSkill[] {
  const skills: OwnSkill[] = [];
  for (const dir of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(skillsDir, dir.name, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    skills.push({ meta: parseSkillMeta(text, dir.name), file });
  }
  return skills.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

/** Reconstruct the activation state from the current branch: the last `pstack-state` entry wins. */
export function stateFromBranch(entries: readonly { type: string; customType?: string; data?: unknown }[]): PstackState {
  let state = OFF;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data as Partial<PstackState> | undefined;
    state = { active: data?.active === true, poteto: data?.active === true && data?.poteto === true };
  }
  return state;
}

const QUESTION_PARAMS = Type.Object({
  title: Type.Optional(Type.String({ description: "Optional heading shown above the questions" })),
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Stable id returned with the answer" }),
      prompt: Type.String({ description: "Question shown to the user" }),
      options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() }), { minItems: 1 }),
      allow_multiple: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option" })),
    }),
    { minItems: 1 },
  ),
});

const TASK_PARAMS = Type.Object({
  description: Type.String({ description: "Short (3-5 word) task description" }),
  prompt: Type.String({ description: "Full instructions for the subagent" }),
  subagent_type: Type.Optional(Type.String()),
  model: Type.Optional(
    Type.String({ description: "Pi model id provider/id[:thinking]; omit, `inherit-parent`, or `auto` for the parent model" }),
  ),
  readonly: Type.Optional(Type.Boolean()),
  run_in_background: Type.Optional(Type.Boolean()),
  resume: Type.Optional(Type.String({ description: "Id of a previous Task to resume" })),
  environment: Type.Optional(Type.String({ description: "Upstream `cloud` runs as the local substitute" })),
  isolation: Type.Optional(StringEnum(["worktree"] as const, { description: "Run in a fresh git worktree on branch pstack/<id>" })),
});

const TASK_ID_PARAMS = Type.Object({ taskId: Type.String({ description: "Task id returned by Task" }) });
const TASK_STATUS_PARAMS = Type.Object({ taskId: Type.Optional(Type.String({ description: "Omit to list this session's tasks" })) });
const TASK_OUTPUT_PARAMS = Type.Object({
  taskId: Type.String({ description: "Task id returned by Task" }),
  wait: Type.Optional(Type.Boolean({ description: "Block until the task finishes" })),
  timeoutSeconds: Type.Optional(Type.Number({ description: "With wait: give up after this many seconds (default 600)" })),
});

const CONFIG_PARAMS = Type.Object({
  action: StringEnum(["read", "write"] as const),
  roles: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
      description: "write: every role -> model value; panel roles take a list",
    }),
  ),
  budget: Type.Optional(StringEnum(Object.keys(BUDGETS) as (keyof typeof BUDGETS)[])),
});

const OWNED_TOOL_NAMES = [
  "Task",
  "TaskStatus",
  "TaskOutput",
  "TaskCancel",
  "AskQuestion",
  "pstack_config",
  "GoalSet",
  "GoalDone",
  "LoopStart",
  "LoopStop",
  "LoopSchedule",
] as const;
const SECTION_NAMES = ["pstack_adapter", "pstack_rules", "pstack_mode", "pstack_goal", "pstack_paths"] as const;

const GOAL_SET_PARAMS = Type.Object({ objective: Type.String({ description: "The full objective and its done condition" }) });
const GOAL_DONE_PARAMS = Type.Object({
  summary: Type.String({ description: "Evidence that the goal is complete, or (blocked) the question for the user" }),
  blocked: Type.Optional(Type.Boolean({ description: "true = waiting on the user; pauses the goal instead of completing it" })),
});
const LOOP_START_PARAMS = Type.Object({
  prompt: Type.String({ description: "Prompt sent on every tick, verbatim (may be a /command)" }),
  intervalSeconds: Type.Optional(Type.Number({ description: "Fixed interval (30s..1d). Omit for a dynamic loop scheduled with LoopSchedule" })),
});
const LOOP_ID_PARAMS = Type.Object({ loopId: Type.String({ description: "Loop id, or `all` for LoopStop" }) });
const LOOP_SCHEDULE_PARAMS = Type.Object({
  loopId: Type.String(),
  delaySeconds: Type.Number({ description: "Seconds until the next tick (clamped to 30s..1d)" }),
});

/** Nesting depth of this Pi process: 0 = user's chat, N = subagent at level N. */
const ownDepth = (): number => Number(process.env.PSTACK_DEPTH ?? 0) || 0;

function taskSummary(meta: TaskMeta, home: string): string {
  const end = meta.endedAt ? Date.parse(meta.endedAt) : Date.now();
  const start = meta.startedAt ? Date.parse(meta.startedAt) : end;
  return [
    `${meta.id} [${meta.status}] ${meta.description}`,
    `  type ${meta.subagentType}, model ${meta.model}${meta.thinking ? `:${meta.thinking}` : ""}, ${meta.background ? "background" : "foreground"}${meta.readonly ? ", readonly" : ""}, ${Math.round((end - start) / 1000)}s, ${meta.usage.turns} turns`,
    `  output ${outputPath(home, meta.id)}${meta.worktree ? `\n  worktree ${meta.worktree.path} (branch ${meta.worktree.branch})` : ""}${meta.error ? `\n  error: ${meta.error}` : ""}`,
  ].join("\n");
}

/**
 * Follow a task owned by another process through its stored meta until it settles, `deadline`
 * (epoch ms) passes, or `signal` aborts. Resolves undefined when it gives up; never outlives that.
 */
async function pollUntilSettled(home: string, id: string, deadline: number, signal: AbortSignal | undefined): Promise<RunResult | undefined> {
  while (!signal?.aborted && Date.now() < deadline) {
    const meta = readMeta(home, id);
    if (meta && meta.status !== "running" && meta.status !== "queued") {
      let output = "";
      try {
        output = readFileSync(outputPath(home, id), "utf8");
      } catch {}
      return { meta, output, ok: meta.status === "done" };
    }
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
  }
  return undefined;
}

function resultText(r: RunResult, home: string): string {
  if (r.ok) return r.output;
  return `Task ${r.meta.id} ${r.meta.status}: ${r.meta.error ?? "unknown error"}${r.output ? `\n\nLast output:\n${r.output}` : ""}\n\n${taskSummary(r.meta, home)}`;
}

export interface PstackOptions {
  /** This package's `skills/` dir (vendored from upstream). Default: resolved from this file's location. */
  skillsDir?: string;
  /** This package's own skills that are not vendored (`extras/skills/`, e.g. create-skill). Default: resolved
   * from this file's location; with an explicit `skillsDir` and no `extraSkillsDir`, none. */
  extraSkillsDir?: string;
}

export function pstackExtension(pi: ExtensionAPI, options: PstackOptions = {}): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const skillsDir = options.skillsDir ?? resolve(here, "../../skills");
  const extraSkillsDir = options.extraSkillsDir ?? (options.skillsDir ? undefined : resolve(here, "../../extras/skills"));
  const skillDirs = [skillsDir, ...(extraSkillsDir && existsSync(extraSkillsDir) ? [extraSkillsDir] : [])];
  const skills = skillDirs.flatMap(loadOwnSkills).sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  const skillMetas = skills.map((s) => s.meta);
  /** realpath of each own SKILL.md → skill name. */
  const skillsRoots = skillDirs.map((d) => realpathOrSelf(d) + sep);
  const ownSkillFiles = new Map(
    skills
      .map((s) => [realpathOrSelf(s.file), s.meta.name] as const)
      .filter(([real]) => skillsRoots.some((root) => real.startsWith(root)) && basename(real) === "SKILL.md"),
  );

  const extensionFile = fileURLToPath(import.meta.url);
  const agentTypes = loadAgentTypes(resolve(skillsDir, "../agents"));
  /** CHILD_BUILTINS the parent itself runs (absent with --no-mcp / -ne). builtin:mcp registers its `/mcp`
   * command at load but its tools only as servers connect, so it is detected from the command source;
   * codemode is detected from its tool. Read at each spawn. */
  const parentBuiltins = (): string[] => {
    const loaded = new Set([
      ...pi.getAllTools().map((t) => t.sourceInfo?.path),
      ...pi.getCommands().map((c) => c.sourceInfo?.path),
    ].filter((p): p is string => !!p && p.startsWith("builtin:")));
    return CHILD_BUILTINS.filter((b) => loaded.has(`builtin:${b}`));
  };

  /** Cursor's `mcps/` directory / available-tools map: the MCP servers and their reachable tools now. */
  const mcpInventory = (): string[] => {
    const byServer = new Map<string, string[]>();
    for (const t of pi.getAllTools()) {
      // Pi cannot unregister tools: disabled servers and hidden tools stay registered with `hidden` exposure.
      if ((t as { exposure?: string }).exposure === "hidden") continue;
      const m = /^mcp__(.+?)__(.+)$/.exec(t.name);
      if (m) byServer.set(m[1]!, [...(byServer.get(m[1]!) ?? []), m[2]!]);
    }
    const header =
      "- MCP (Cursor's `mcps/` directory / available-tools map): Pi's own MCP client. Tools are named `mcp__<server>__<tool>`; servers marked codemode in the mcp_servers prompt section are called from `codemode` scripts (find them with `searchTools()` / `describeTool()`), deferred ones load with `tool_search`. Agent-mode Tasks load the same MCP configuration (same project trust); `readonly` Tasks get none. Servers still connecting are not listed yet.";
    if (!byServer.size) return [header, "- MCP servers with reachable tools now: none."];
    return [
      header,
      "- MCP servers with reachable tools now:",
      ...[...byServer].map(([s, tools]) => `  - ${s}: ${tools.length} tool(s) (${tools.slice(0, 8).join(", ")}${tools.length > 8 ? ", …" : ""})`),
    ];
  };
  let runner: TaskRunner | undefined;
  let runnerHome = "";
  const getRunner = (): TaskRunner => {
    const home = pstackHome();
    if (!runner || runnerHome !== home) {
      runner = new TaskRunner(home, { extensionPath: extensionFile, skillsDir, extraSkillsDir: skillDirs[1], builtins: parentBuiltins });
      runnerHome = home;
    }
    return runner;
  };

  let state: PstackState = OFF;
  /** Tools this extension registered; their current source is rechecked before toggling. */
  const ownedTools = new Set<string>();
  const extensionPath = realpathOrSelf(fileURLToPath(import.meta.url));
  const toolCollisions: string[] = [];
  const commandCollisions = new Set<string>();
  const shownHints = new Set<string>();
  const pendingHints: string[] = [];
  const shownWarnings = new Set<string>();

  const warn = (ctx: ExtensionContext, message: string) => {
    if (shownWarnings.has(message)) return;
    shownWarnings.add(message);
    ctx.ui.notify(message, "warning");
  };

  const currentOwnedTools = (ctx: ExtensionContext): Set<string> => {
    const effective = new Map(pi.getAllTools().map((t) => [t.name, t.sourceInfo.path]));
    const current = new Set<string>();
    for (const name of ownedTools) {
      if (realpathOrSelf(effective.get(name) ?? "") === extensionPath) current.add(name);
      else if (!toolCollisions.includes(name)) {
        toolCollisions.push(name);
        warn(ctx, `pstack: tool "${name}" is now owned by another extension; pstack runs without its own ${name}.`);
      }
    }
    return current;
  };

  const applyTools = (ctx: ExtensionContext) => {
    const owned = currentOwnedTools(ctx);
    const current = pi.getActiveTools();
    const next = state.active
      ? [...new Set([...current, ...owned])]
      : current.filter((name) => !owned.has(name));
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) pi.setActiveTools(next);
  };

  const setState = (next: PstackState, ctx: ExtensionContext) => {
    if (next.active !== state.active || next.poteto !== state.poteto) {
      state = next;
      pi.appendEntry(STATE_ENTRY, { ...state });
    }
    applyTools(ctx);
  };

  const activate = (poteto: boolean, ctx: ExtensionContext) => setState({ active: true, poteto: state.poteto || poteto }, ctx);

  // Provenance for the poteto grant. Pi's command context does not say who dispatched a command, and
  // extension commands run before the input event, so this extension tracks its own model-originated
  // dispatches: the exact text it sends for a model-started loop is marked, and the command or input it
  // turns into (matched by text, consumed once) is model-originated. A /loop started that way is
  // model-started too, so nesting does not launder the origin.
  const modelDispatches: string[] = [];
  const markModelDispatch = (text: string) => {
    modelDispatches.push(text.trim());
  };
  /** True (and consumes the mark) when `text` is what a model loop just dispatched. */
  const takeModelDispatch = (text: string): boolean => {
    const i = modelDispatches.indexOf(text.trim());
    if (i === -1) return false;
    modelDispatches.splice(i, 1);
    return true;
  };
  /** The poteto grant: only when the caller is not a model-originated dispatch. In a Task child every input is
   * model-authored (the parent model wrote the Task prompt, sent on stdin, which print mode dispatches as if typed),
   * so a child never grants poteto from its own input (children start active, without poteto). */
  const activateFrom = (wantsPoteto: boolean, byModel: boolean, ctx: ExtensionContext) => {
    if (wantsPoteto && (byModel || !!process.env.PSTACK_TASK_ID)) {
      activate(false, ctx);
      ctx.ui.notify(
        process.env.PSTACK_TASK_ID
          ? "pstack: /poteto-mode inside a Task is model-authored and does not enable poteto mode."
          : "pstack: /poteto-mode from a model-started loop does not enable poteto mode; run it yourself.",
        "warning",
      );
      return;
    }
    activate(wantsPoteto, ctx);
  };

  /** Name of the own skill that Pi's `/skill:<name>` resolves to, or undefined (unknown or another package's skill). */
  const resolveSkillCommand = (name: string): string | undefined => {
    const command = pi.getCommands().find((c) => c.source === "skill" && c.name === `skill:${name}`);
    if (!command) return undefined;
    return ownSkillFiles.get(realpathOrSelf(command.sourceInfo.path));
  };

  const reconcile = (ctx: ExtensionContext) => {
    state = stateFromBranch(ctx.sessionManager.getBranch());
    goal = goalFromBranch(ctx.sessionManager.getBranch());
    showGoalStatus(ctx);
    applyTools(ctx);
  };

  // ---------- tools ----------

  const registerOwned = (ctx: ExtensionContext) => {
    const existing = new Set(pi.getAllTools().map((t) => t.name));
    for (const name of OWNED_TOOL_NAMES) {
      if (ownedTools.has(name) || toolCollisions.includes(name)) continue;
      if (existing.has(name)) {
        toolCollisions.push(name);
        warn(ctx, `pstack: tool "${name}" is already registered by another extension; pstack runs without its own ${name}.`);
        continue;
      }
      registerTool(name);
      ownedTools.add(name);
    }
  };

  const registerTool = (name: (typeof OWNED_TOOL_NAMES)[number]) => {
    if (name === "AskQuestion") {
      pi.registerTool({
        name,
        label: "AskQuestion",
        description:
          "Ask the user one or more multiple-choice questions and wait for the answers. Returns the selected option ids and labels per question.",
        parameters: QUESTION_PARAMS,
        defaultActive: false,
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const result = await askQuestions(params, ctx);
          const text = result.cancelled
            ? `The user cancelled AskQuestion. Answers given before cancelling: ${JSON.stringify(result.answers)}`
            : JSON.stringify(result.answers, null, 2);
          return { content: [{ type: "text", text }], details: result };
        },
      });
    } else if (name === "Task") {
      pi.registerTool({
        name,
        label: "Task",
        description:
          "Launch a subagent for a delegated task. `model` is a Pi id provider/id[:thinking]; omit it (or pass inherit-parent/auto) to use the parent model.",
        parameters: TASK_PARAMS,
        defaultActive: false,
        async execute(_id, params, signal, onUpdate, ctx) {
          return runTask(params, signal, onUpdate, ctx);
        },
      });
    } else if (name === "TaskStatus") {
      pi.registerTool({
        name,
        label: "TaskStatus",
        description: "Show one Task's status, or list the Tasks started by this session. Never resumes or wakes a task.",
        parameters: TASK_STATUS_PARAMS,
        defaultActive: false,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const home = pstackHome();
          if (params.taskId) {
            const meta = readMeta(home, params.taskId);
            if (!meta) throw new Error(`Unknown task "${params.taskId}".`);
            return { content: [{ type: "text", text: taskSummary(meta, home) }], details: meta };
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const mine = listTasks(home).filter((m) => m.parentSessionId === sessionId);
          const text = mine.length ? mine.map((m) => taskSummary(m, home)).join("\n") : "No tasks started by this session.";
          return { content: [{ type: "text", text }], details: { tasks: mine } };
        },
      });
    } else if (name === "TaskOutput") {
      pi.registerTool({
        name,
        label: "TaskOutput",
        description: "Get a Task's final output. With wait: true, block until it finishes (or timeoutSeconds passes).",
        parameters: TASK_OUTPUT_PARAMS,
        defaultActive: false,
        async execute(_id, params, signal) {
          const home = pstackHome();
          const meta = readMeta(home, params.taskId);
          if (!meta) throw new Error(`Unknown task "${params.taskId}".`);
          const live = (m: TaskMeta) => m.status === "running" || m.status === "queued";
          // Tasks owned by another Pi process (e.g. a subagent's own children) are followed through the store.
          const timeout = (params.timeoutSeconds ?? 600) * 1000;
          const pending =
            getRunner().wait(params.taskId) ??
            (params.wait && live(meta) ? pollUntilSettled(home, params.taskId, Date.now() + timeout, signal) : undefined);
          if (pending && params.wait) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;
            const outcome = await Promise.race([
              pending,
              new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeout))),
              new Promise<"aborted">((r) => {
                onAbort = () => r("aborted");
                if (signal?.aborted) onAbort();
                else signal?.addEventListener("abort", onAbort, { once: true });
              }),
            ]).finally(() => {
              clearTimeout(timer);
              if (onAbort) signal?.removeEventListener("abort", onAbort);
            });
            if (outcome === "timeout" || outcome === "aborted" || outcome === undefined) {
              const now = readMeta(home, params.taskId)!;
              return { content: [{ type: "text", text: `Still ${now.status} (${signal?.aborted ? "aborted" : "timeout"}).\n${taskSummary(now, home)}` }], details: now };
            }
            // Pi marks a tool result failed only when execute() throws.
            markConsumed(outcome.meta);
            if (!outcome.ok) throw new Error(resultText(outcome, home));
            return { content: [{ type: "text", text: resultText(outcome, home) }], details: outcome.meta };
          }
          const now = readMeta(home, params.taskId)!;
          if (now.status === "running" || now.status === "queued") {
            return { content: [{ type: "text", text: `Still ${now.status}.\n${taskSummary(now, home)}` }], details: now };
          }
          let output = "";
          try {
            output = readFileSync(outputPath(home, now.id), "utf8");
          } catch {}
          const r: RunResult = { meta: now, output, ok: now.status === "done" };
          markConsumed(now);
          if (!r.ok) throw new Error(resultText(r, home));
          return { content: [{ type: "text", text: resultText(r, home) }], details: now };
        },
      });
    } else if (name === "TaskCancel") {
      pi.registerTool({
        name,
        label: "TaskCancel",
        description: "Cancel a running or queued Task (SIGTERM, then SIGKILL after 5s).",
        parameters: TASK_ID_PARAMS,
        defaultActive: false,
        async execute(_id, params) {
          const home = pstackHome();
          const meta = readMeta(home, params.taskId);
          if (!meta) throw new Error(`Unknown task "${params.taskId}".`);
          const pending = getRunner().wait(params.taskId);
          if (!pending || !getRunner().cancel(params.taskId)) {
            if (meta.status === "running" || meta.status === "queued") {
              throw new Error(
                `Task ${meta.id} is ${meta.status} but owned by another Pi process (pid ${meta.ownerPid}); only its owner can cancel it. Cancel the owning task instead${meta.parentTaskId ? ` (${meta.parentTaskId})` : ""}.`,
              );
            }
            return { content: [{ type: "text", text: `Task ${meta.id} is not running (status ${meta.status}).` }], details: meta };
          }
          const r = await pending;
          return { content: [{ type: "text", text: `Cancelled.\n${taskSummary(r.meta, home)}` }], details: r.meta };
        },
      });
    } else if (name === "GoalSet") {
      pi.registerTool({
        name,
        label: "GoalSet",
        description:
          "Arm a long-lived /goal that keeps the agent working across turns until GoalDone. Only when the user asked for a goal or gave the explicit go a playbook requires; it does not widen what you are allowed to do.",
        parameters: GOAL_SET_PARAMS,
        defaultActive: false,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          armGoal(params.objective, ctx);
          return { content: [{ type: "text", text: `Goal armed: ${params.objective}` }], details: goal };
        },
      });
    } else if (name === "GoalDone") {
      pi.registerTool({
        name,
        label: "GoalDone",
        description:
          "Mark the armed /goal complete (with evidence), or with blocked: true pause it until the user answers the question in summary.",
        parameters: GOAL_DONE_PARAMS,
        defaultActive: false,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          if (!goal || (goal.status !== "active" && goal.status !== "paused")) throw new Error("No armed goal.");
          const status = params.blocked ? "paused" : "done";
          setGoal({ ...goal, status, note: params.summary, since: new Date().toISOString() }, ctx);
          return { content: [{ type: "text", text: params.blocked ? `Goal paused, waiting on the user: ${params.summary}` : `Goal done: ${params.summary}` }], details: goal };
        },
      });
    } else if (name === "LoopStart") {
      pi.registerTool({
        name,
        label: "LoopStart",
        description:
          "Start a /loop: send `prompt` now and then repeatedly, every intervalSeconds, or (no interval) when you schedule the next wake with LoopSchedule. Runs only while this Pi process is open.",
        parameters: LOOP_START_PARAMS,
        defaultActive: false,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const intervalMs = params.intervalSeconds === undefined ? undefined : clampDelayMs(params.intervalSeconds);
          // Poteto mode is a user grant; a model-started loop must not be a way to switch it on.
          if (/^\/(?:skill:)?poteto-mode\b/.test(params.prompt.trim())) {
            throw new Error("LoopStart cannot run /poteto-mode: poteto mode is enabled only by the user.");
          }
          const loop = startLoop(params.prompt, intervalMs, ctx, true);
          return { content: [{ type: "text", text: `Loop ${loop.id} started (${formatInterval(intervalMs)}).` }], details: loop };
        },
      });
    } else if (name === "LoopStop") {
      pi.registerTool({
        name,
        label: "LoopStop",
        description: "Stop a /loop by id, or all loops with loopId `all`.",
        parameters: LOOP_ID_PARAMS,
        defaultActive: false,
        async execute(_id, params) {
          if (params.loopId === "all") {
            const n = loops.size;
            stopAllLoops();
            return { content: [{ type: "text", text: `Stopped ${n} loop(s).` }], details: undefined };
          }
          if (!stopLoop(params.loopId)) throw new Error(`No loop "${params.loopId}". ${loopListText()}`);
          return { content: [{ type: "text", text: `Stopped loop ${params.loopId}.` }], details: undefined };
        },
      });
    } else if (name === "LoopSchedule") {
      pi.registerTool({
        name,
        label: "LoopSchedule",
        description: "For a dynamic /loop (no interval): set when the next tick fires. Without it the next tick is in 10 minutes.",
        parameters: LOOP_SCHEDULE_PARAMS,
        defaultActive: false,
        async execute(_id, params) {
          const live = loops.get(params.loopId);
          if (!live) throw new Error(`No loop "${params.loopId}". ${loopListText()}`);
          if (live.loop.intervalMs !== undefined) throw new Error(`Loop ${params.loopId} has a fixed interval; stop it and start a dynamic one to schedule ticks.`);
          live.scheduledMs = clampDelayMs(params.delaySeconds);
          if (!live.inFlight) {
            armLoop(live, live.scheduledMs);
            recordLoop({ op: "schedule", id: live.loop.id, nextAt: live.nextAt! });
          }
          return { content: [{ type: "text", text: `Next tick of ${params.loopId} in ${Math.round(live.scheduledMs / 1000)}s.` }], details: undefined };
        },
      });
    } else {
      pi.registerTool({
        name,
        label: "pstack_config",
        description:
          "Read or write the pstack per-role model configuration. `read` returns the parsed config and a validation report. `write` takes the full role->value map plus budget, validates it, and writes the rule file atomically.",
        parameters: CONFIG_PARAMS,
        defaultActive: false,
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const result = runConfigTool(params, ctx);
          return { content: [{ type: "text", text: result.text }], details: result.details };
        },
      });
    }
  };

  const runTask = async (
    params: Static<typeof TASK_PARAMS>,
    signal: AbortSignal | undefined,
    onUpdate: ((r: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
    ctx: ExtensionContext,
  ) => {
    const home = pstackHome();
    const depth = ownDepth() + 1;
    if (depth > MAX_DEPTH) {
      throw new Error(`Task nesting limit reached (root plus ${MAX_DEPTH} subagent levels). Do this work yourself instead of delegating.`);
    }
    const lookup = lookupFromRegistry(ctx.modelRegistry);
    const gate = taskGate(readModelsRule(home), params.model, lookup);
    if (gate.stage !== "ok") throw new Error(gate.text);

    const previous = params.resume ? readMeta(home, params.resume) : undefined;
    if (params.resume) {
      if (!previous) throw new Error(`Unknown task "${params.resume}"; cannot resume.`);
      if (getRunner().isRunning(previous.id) || previous.status === "running" || previous.status === "queued") {
        throw new Error(`Task ${previous.id} is still running; read its status (TaskStatus / TaskOutput) instead of resuming.`);
      }
    }
    const typeName = params.subagent_type ?? previous?.subagentType ?? "generalPurpose";
    const agent = agentTypes.find((a) => a.name === typeName);
    if (!agent) throw new Error(`Unknown subagent_type "${typeName}". Available: ${agentTypes.map((a) => a.name).join(", ")}.`);

    let model: string;
    let thinking: string | undefined;
    if (gate.model.kind === "model") {
      model = `${gate.model.provider}/${gate.model.id}`;
      thinking = gate.model.level;
    } else if (previous && params.model === undefined) {
      model = previous.model;
      thinking = previous.thinking;
    } else {
      if (!ctx.model) throw new Error("No parent model is selected; pass an explicit Task model.");
      model = `${ctx.model.provider}/${ctx.model.id}`;
      thinking = pi.getThinkingLevel();
    }

    const background = params.run_in_background === true;
    const parentReadonly = process.env.PSTACK_READONLY === "1";
    let meta: TaskMeta;
    if (previous) {
      meta = {
        ...previous,
        model,
        thinking,
        background,
        depth,
        parentTaskId: process.env.PSTACK_TASK_ID || undefined,
        readonly: parentReadonly || (params.readonly ?? previous.readonly),
        // The resuming caller's trust decision, not the creator's: a resume never widens project trust.
        projectTrusted: ctx.isProjectTrusted(),
        parentSessionId: ctx.sessionManager.getSessionId(),
      };
    } else {
      const id = newTaskId();
      let cwd = ctx.cwd;
      let worktree: TaskMeta["worktree"];
      if (params.isolation === "worktree") {
        worktree = createWorktree(home, id, ctx.cwd);
        cwd = worktree.path;
      }
      meta = {
        id,
        parentTaskId: process.env.PSTACK_TASK_ID || undefined,
        parentSessionId: ctx.sessionManager.getSessionId(),
        ownerPid: process.pid,
        depth,
        description: params.description,
        subagentType: agent.name,
        model,
        thinking,
        readonly: parentReadonly || params.readonly === true || agent.readonly === true,
        background,
        cwd,
        worktree,
        environmentNote: params.environment === "cloud" ? CLOUD_NOTE : undefined,
        status: "queued",
        runs: 0,
        createdAt: new Date().toISOString(),
        usage: emptyUsage(),
        projectTrusted: ctx.isProjectTrusted(),
      };
    }
    writeMeta(home, meta);

    // A prompt that starts with an own skill command (`/how …`) would hit the child's command handler, which
    // forwards via sendUserMessage — and in print mode that lands after the session is disposed (no reply).
    // Send Pi's equivalent `/skill:<name> …` instead: the child expands the skill directly.
    const lead = /^\/([a-z0-9-]+)(?=\s|$)/.exec(params.prompt.trimStart());
    const childPrompt = lead && skillMetas.some((s) => s.name === lead[1]) ? `/skill:${params.prompt.trimStart().slice(1)}` : params.prompt;
    const done = getRunner().start(meta, agent, childPrompt, previous !== undefined, (p) =>
      background
        ? undefined
        : onUpdate?.({
            content: [{ type: "text", text: p.text || "(running...)" }],
            details: { taskId: meta.id, status: "running", toolCalls: p.toolCalls, usage: p.usage },
          }),
    );
    const head = [`taskId: ${meta.id}`, meta.environmentNote ? `environment_note: ${meta.environmentNote}` : "", meta.worktree ? `worktree: ${meta.worktree.path} (branch ${meta.worktree.branch})` : ""].filter(Boolean);
    if (background) {
      void done.then((r) => queueNotification(r.meta));
      const status = readMeta(home, meta.id)?.status ?? "running";
      const text = [...head, `status: ${status} in background`, `output: ${outputPath(home, meta.id)}`, "You will get a completion message when it finishes; TaskStatus / TaskOutput (wait: true blocks) inspect it meanwhile. Do not resume a running task."].join("\n");
      return { content: [{ type: "text" as const, text }], details: { taskId: meta.id, status, background: true } };
    }
    const abort = () => getRunner().cancel(meta.id);
    signal?.addEventListener("abort", abort, { once: true });
    const r = await done;
    signal?.removeEventListener("abort", abort);
    markConsumed(r.meta);
    if (!r.ok) throw new Error(resultText(r, home));
    const text = head.length > 1 ? `${head.slice(1).join("\n")}\n\n${r.output}` : r.output;
    return { content: [{ type: "text" as const, text }], details: { taskId: meta.id, status: r.meta.status, model: r.meta.model, usage: r.meta.usage, exitCode: r.meta.exitCode } };
  };

  // ---------- background completion notifications ----------
  // A settled background run is queued here, then delivered at an idle boundary after re-checking
  // that pstack is still active, the chat is the one that started it, and the parent has not already
  // read the result. Not exactly-once across crashes: delivery is recorded in meta just before sending.

  /** taskId -> run number awaiting delivery. */
  const pendingNotifications = new Map<string, number>();
  let lastCtx: ExtensionContext | undefined;

  const markConsumed = (meta: TaskMeta) => {
    pendingNotifications.delete(meta.id);
    const now = readMeta(pstackHome(), meta.id);
    if (now && now.consumedRun !== now.runs) writeMeta(pstackHome(), { ...now, consumedRun: now.runs });
  };

  const queueNotification = (meta: TaskMeta) => {
    if (meta.status !== "done" && meta.status !== "error") return;
    pendingNotifications.set(meta.id, meta.runs);
    queueMicrotask(() => {
      if (lastCtx?.isIdle()) flushNotifications(lastCtx);
    });
  };

  const notifiedInBranch = (ctx: ExtensionContext): Set<string> => {
    const keys = new Set<string>();
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type === "custom_message" && e.customType === TASK_DONE_MESSAGE && e.details) keys.add(`${e.details.taskId}:${e.details.runs}`);
    }
    return keys;
  };

  const flushNotifications = (ctx: ExtensionContext) => {
    if (!pendingNotifications.size) return;
    const home = pstackHome();
    const sessionId = ctx.sessionManager.getSessionId();
    const already = notifiedInBranch(ctx);
    for (const [id, run] of [...pendingNotifications]) {
      const meta = readMeta(home, id);
      if (!meta || meta.runs !== run || meta.parentSessionId !== sessionId) {
        // Another session's task (session switched) stays queued for that session; a re-run supersedes.
        if (!meta || meta.runs !== run) pendingNotifications.delete(id);
        continue;
      }
      pendingNotifications.delete(id);
      if (meta.consumedRun === run || meta.notifiedRun === run || already.has(`${id}:${run}`)) continue;
      if (!state.active) {
        writeMeta(home, { ...meta, notifiedRun: run });
        continue;
      }
      writeMeta(home, { ...meta, notifiedRun: run });
      let output = "";
      try {
        output = readFileSync(outputPath(home, id), "utf8");
      } catch {}
      const content = [
        `Background Task ${id} (${meta.description}) finished: ${meta.status}.`,
        meta.error ? `Error: ${meta.error}` : "",
        output ? `Output (first 2000 chars):\n${output.slice(0, 2000)}` : "",
        `Full result: TaskOutput { taskId: "${id}" }.`,
      ]
        .filter(Boolean)
        .join("\n");
      pi.sendMessage(
        { customType: TASK_DONE_MESSAGE, content, display: true, details: { taskId: id, runs: run, status: meta.status } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  };

  /** After a restart: settled runs of this session that were never delivered or read. */
  const recoverNotifications = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const meta of listTasks(pstackHome())) {
      if (meta.parentSessionId !== sessionId || !meta.background) continue;
      if (meta.status !== "done" && meta.status !== "error") continue;
      if (meta.notifiedRun === meta.runs || meta.consumedRun === meta.runs) continue;
      pendingNotifications.set(meta.id, meta.runs);
    }
  };

  // ---------- /goal ----------
  // A long-lived objective (Cursor /goal). While active, a run that ends normally is continued at
  // agent_before_settle until GoalDone. Abort or a model error pauses it; a new user message resumes it.

  let goal: Goal | undefined;

  const showGoalStatus = (ctx: ExtensionContext) => {
    const text = goal && (goal.status === "active" || goal.status === "paused") ? `goal ${goal.status}: ${goal.objective.slice(0, 60)}` : undefined;
    ctx.ui.setStatus?.("pstack-goal", text);
  };

  const setGoal = (next: Goal, ctx: ExtensionContext) => {
    goal = next;
    pi.appendEntry(GOAL_ENTRY, next);
    showGoalStatus(ctx);
  };

  const armGoal = (objective: string, ctx: ExtensionContext) => {
    activate(false, ctx);
    setGoal({ objective, status: "active", since: new Date().toISOString() }, ctx);
  };

  pi.on("agent_before_settle", (event, ctx) => {
    const decision = decideGoalSettle({
      goal,
      pstackActive: state.active,
      outcome: event.outcome,
      alreadyContinuing: event.continue,
      pendingInput: ctx.hasPendingMessages(),
    });
    if (decision.kind === "pause" && goal) {
      setGoal({ ...goal, status: "paused", note: decision.note, since: new Date().toISOString() }, ctx);
      ctx.ui.notify(`pstack: goal ${decision.note}. Send a message or /goal resume to continue.`, "info");
      return;
    }
    if (decision.kind === "continue") {
      return {
        continue: true,
        // Pi replaces the boundary's entries with ours, so keep what earlier handlers proposed.
        entries: [...event.entries, { type: "custom_message" as const, customType: GOAL_CONTINUE_MESSAGE, content: GOAL_CONTINUE_TEXT, display: false }],
      };
    }
  });

  const goalStatusText = (): string =>
    goal ? `goal ${goal.status}${goal.note ? ` (${goal.note})` : ""}: ${goal.objective}` : "no goal";

  // ---------- /loop ----------
  // Loop definitions live in session entries; timers run only while this Pi process lives.

  interface LiveLoop {
    loop: Loop;
    timer?: ReturnType<typeof setTimeout>;
    nextAt?: number;
    ticks: number;
    skipped: number;
    /** A tick came due while busy; fire at the next agent_settled. */
    due: boolean;
    /** Dynamic loop: next delay set by LoopSchedule during the current tick's run. */
    scheduledMs?: number;
    inFlight: boolean;
  }
  const loops = new Map<string, LiveLoop>();
  let loopSeq = 0;
  /** Set at session_shutdown: the runtime is being replaced, so stale timers must do nothing. */
  let disposed = false;

  const recordLoop = (entry: LoopEntry) => pi.appendEntry(LOOP_ENTRY, entry);

  const armLoop = (live: LiveLoop, delayMs: number) => {
    if (live.timer) clearTimeout(live.timer);
    live.nextAt = Date.now() + delayMs;
    live.timer = setTimeout(() => fireLoop(live.loop.id), delayMs);
    live.timer.unref?.();
  };

  const fireLoop = (id: string) => {
    const live = loops.get(id);
    if (!live || disposed) return;
    live.timer = undefined;
    const ctx = lastCtx;
    if (!ctx || !state.active) return;
    try {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        live.skipped++;
        live.due = true;
        return;
      }
    } catch {
      return; // stale context after a reload: the new runtime restores loops itself
    }
    live.due = false;
    live.ticks++;
    live.inFlight = true;
    live.scheduledMs = undefined;
    pi.sendMessage({ customType: LOOP_TICK_MESSAGE, content: `/loop ${id} tick ${live.ticks}`, display: true, details: { loopId: id, tick: live.ticks } });
    // The prompt goes in unchanged so `/how …` or `/skill:…` still expand.
    // A model-started loop's text is marked so the command/input it becomes cannot carry a user grant.
    if (live.loop.byModel) markModelDispatch(live.loop.prompt);
    pi.sendUserMessage(live.loop.prompt, { expandPromptTemplates: true });
    // Fixed loops re-arm now. Dynamic loops get a fallback wake in case the prompt starts no run
    // (an extension command, a failed dispatch); agent_settled replaces it with the scheduled delay.
    armLoop(live, live.loop.intervalMs ?? DYNAMIC_DEFAULT_MS);
  };

  const startLoop = (prompt: string, intervalMs: number | undefined, ctx: ExtensionContext, byModel: boolean): Loop => {
    activate(false, ctx);
    const loop: Loop = {
      id: `l${Date.now().toString(36)}${(loopSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      prompt,
      ...(intervalMs === undefined ? {} : { intervalMs }),
      sessionId: ctx.sessionManager.getSessionId(),
      createdAt: new Date().toISOString(),
      ...(byModel ? { byModel: true } : {}),
    };
    recordLoop({ op: "add", loop });
    const live: LiveLoop = { loop, ticks: 0, skipped: 0, due: false, inFlight: false };
    loops.set(loop.id, live);
    lastCtx = ctx;
    // First tick right away (Cursor runs the prompt, then repeats).
    queueMicrotask(() => fireLoop(loop.id));
    return loop;
  };

  const stopLoop = (id: string): boolean => {
    const live = loops.get(id);
    if (!live) return false;
    if (live.timer) clearTimeout(live.timer);
    loops.delete(id);
    recordLoop({ op: "stop", id });
    return true;
  };

  const stopAllLoops = () => {
    for (const id of [...loops.keys()]) stopLoop(id);
  };

  const clearLoopTimers = () => {
    for (const live of loops.values()) if (live.timer) clearTimeout(live.timer);
    loops.clear();
  };

  /** Rebuild live loops from the selected branch (resume, reload, tree navigation); records nothing.
   * A deadline that passed while Pi was closed is a missed tick: it is not replayed, the next one is
   * a full interval (or the default dynamic delay) from now. */
  const restoreLoops = (ctx: ExtensionContext) => {
    clearLoopTimers();
    const now = Date.now();
    for (const { loop, nextAt } of loopsFromBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())) {
      const live: LiveLoop = { loop, ticks: 0, skipped: 0, due: false, inFlight: false };
      loops.set(loop.id, live);
      const full = loop.intervalMs ?? DYNAMIC_DEFAULT_MS;
      armLoop(live, nextAt !== undefined && nextAt > now ? nextAt - now : full);
    }
  };

  const onSettledLoops = () => {
    for (const live of loops.values()) {
      if (live.inFlight) {
        live.inFlight = false;
        if (live.loop.intervalMs === undefined) {
          // Replaces the fallback wake; a fallback that fired during the run is not a second tick.
          live.due = false;
          const delay = live.scheduledMs ?? DYNAMIC_DEFAULT_MS;
          armLoop(live, delay);
          recordLoop({ op: "schedule", id: live.loop.id, nextAt: live.nextAt! });
        }
      }
    }
    for (const live of loops.values()) {
      if (live.due && lastCtx?.isIdle()) {
        fireLoop(live.loop.id);
        break;
      }
    }
  };

  const loopListText = (): string =>
    loops.size
      ? [...loops.values()]
          .map((l) => `${l.loop.id} every ${formatInterval(l.loop.intervalMs)}: ${l.loop.prompt} (ticks ${l.ticks}, skipped ${l.skipped}${l.nextAt ? `, next in ${Math.max(0, Math.round((l.nextAt - Date.now()) / 1000))}s` : ""})`)
          .join("\n")
      : "no loops";

  // ---------- events ----------

  pi.on("session_start", (_event, ctx) => {
    registerOwned(ctx);
    registerCommands(ctx);
    shownHints.clear();
    pendingHints.length = 0;
    reconcile(ctx);
    // Subagent processes start active: the parent already chose pstack.
    if (ownDepth() >= 1 && !state.active) setState({ active: true, poteto: false }, ctx);
    for (const meta of reconcileOrphans(pstackHome())) warn(ctx, `pstack: task ${meta.id} (${meta.description}) ended when its parent Pi exited.`);
    lastCtx = ctx;
    recoverNotifications(ctx);
    if (ctx.isIdle()) flushNotifications(ctx);
    restoreLoops(ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    lastCtx = ctx;
    // Esc skips agent_before_settle (Pi only emits agent_settled with aborted: true), so pause here
    // before a notification or loop tick could start a run the goal would continue.
    if (event.aborted && goal?.status === "active") {
      setGoal({ ...goal, status: "paused", note: "paused: the run was aborted", since: new Date().toISOString() }, ctx);
      ctx.ui.notify("pstack: goal paused (run aborted). Send a message or /goal resume to continue.", "info");
    }
    flushNotifications(ctx);
    onSettledLoops();
  });

  pi.on("session_shutdown", async () => {
    // Reload / session switch: drop timers without stop records so the next runtime restores them.
    disposed = true;
    clearLoopTimers();
    await runner?.cancelAll();
  });

  // A subagent exits when the Pi that owns it dies (crash or SIGKILL skip session_shutdown).
  // SIGTERM to itself runs Pi's own signal path, which kills detached bash process trees and
  // disposes the session (session_shutdown → our cancelAll for grandchildren). Hard exit as a fallback.
  const ownerPid = Number(process.env.PSTACK_OWNER_PID);
  if (ownDepth() >= 1 && ownerPid > 0) {
    watchParent(ownerPid, () => {
      setTimeout(() => process.exit(130), 8000).unref();
      process.kill(process.pid, "SIGTERM");
    });
  }

  pi.on("session_tree", (_event, ctx) => {
    reconcile(ctx);
    lastCtx = ctx;
    restoreLoops(ctx);
  });

  pi.on("input", (event, ctx) => {
    const byModel = takeModelDispatch(event.text);
    if (event.text.startsWith("/skill:")) {
      const space = event.text.indexOf(" ");
      const name = space === -1 ? event.text.slice(7) : event.text.slice(7, space);
      const own = resolveSkillCommand(name);
      if (own) activateFrom(own === POTETO_SKILL, byModel, ctx);
    }
    // Cursor: a new user message on a paused goal re-activates it. Commands (/goal pause …) are not messages.
    if (goal?.status === "paused" && event.source !== "extension" && !event.text.startsWith("/")) {
      setGoal({ ...goal, status: "active", note: undefined, since: new Date().toISOString() }, ctx);
    }
    return { action: "continue" };
  });

  pi.on("tool_result", (event, ctx) => {
    const raw = event.input.path;
    if (typeof raw !== "string" || event.isError) return;
    const path = resolveToolPath(raw, ctx.cwd);
    if (event.toolName === "read" && ownSkillFiles.has(realpathOrSelf(path))) activate(false, ctx);
    if (!state.active || !["read", "edit", "write"].includes(event.toolName)) return;
    for (const hint of pathHints(skillMetas, path, ctx.cwd, shownHints)) {
      shownHints.add(hint.key);
      const skill = skills.find((s) => hint.key.startsWith(pathHintKey(s.meta.name, "")));
      pendingHints.push(skill ? `${hint.text} (${skill.file})` : hint.text);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    for (const name of SECTION_NAMES) {
      delete event.systemPromptOptions.sections[name];
    }
    if (state.active) {
      for (const [name, text] of buildSections(ctx)) event.systemPromptOptions.sections[name] = text;
    }
  });

  // Pi does not re-emit before_agent_start between tool calls in one run. Patch only this
  // request's prompt, leaving other extensions' sections and the transcript untouched.
  pi.on("context_with_system", (event, ctx) => {
    const current = getCurrentSystemMessage(event.messages);
    if (!current) return;
    const desired = state.active ? new Map(buildSections(ctx)) : new Map<string, string>();
    const patch: Record<string, string | null> = {};
    for (const name of SECTION_NAMES) {
      const text = desired.get(name);
      const rendered = text ? `<${name}>\n${text}\n</${name}>` : undefined;
      if (rendered !== current.sections?.[name]) {
        if (rendered || current.sections?.[name] !== undefined) patch[name] = rendered ?? null;
      }
    }
    if (Object.keys(patch).length) {
      return { messages: [...event.messages, { role: "system", content: "", sections: patch, timestamp: Date.now() }] };
    }
  });

  const buildSections = (ctx: ExtensionContext): [string, string][] => {
    const home = pstackHome();
    const out: [string, string][] = [["pstack_adapter", adapterNote(ctx, home)]];
    const loaded = loadAlwaysApplyRules(join(home, "rules"));
    for (const w of loaded.warnings) warn(ctx, w);
    if (loaded.rules.length) {
      out.push(["pstack_rules", loaded.rules.map((r) => `<!-- ${r.file} -->\n${r.body.trim()}`).join("\n\n")]);
    }
    if (state.poteto) out.push(["pstack_mode", [...modeReminders(skillMetas), POTETO_GRANT].join("\n\n")]);
    if (goal?.status === "active") out.push(["pstack_goal", goalSection(goal)]);
    if (pendingHints.length) {
      out.push(["pstack_paths", `${pendingHints.join("\n")}\n(Plugin approximation of Cursor's \`paths\` skill field.)`]);
      pendingHints.length = 0;
    }
    return out;
  };

  const adapterNote = (ctx: ExtensionContext, home: string): string => {
    const models = ctx.modelRegistry
      .getAvailable()
      .map((m) => `- ${m.provider}/${m.id} (thinking: ${getSupportedThinkingLevels(m).join(", ")})`);
    const tools = [...ownedTools].filter((t) => t !== "pstack_config");
    const sessionFile = ctx.sessionManager.getSessionFile();
    return [
      "pstack skills were written for Cursor; in Pi they run through this plugin.",
      tools.length
        ? `- Built-ins provided here: ${tools.join(", ")} (use the schemas shown in their tool declarations).`
        : "- Task and AskQuestion are not provided (name collision with another extension); ask in plain text and do the work yourself.",
      "- Model values are Pi ids `provider/id` with an optional `:<thinking>` suffix (off|minimal|low|medium|high|xhigh|max; support varies per model). `inherit-parent` or `auto` = omit `model`.",
      `- pstack config: ${modelsRulePath(home)}. Write it only through the pstack_config tool.`,
      "- Candidate models for Task (configured credentials, not a liveness check):",
      ...(models.length ? models : ["- (none)"]),
      `- Transcripts are Pi JSONL under ${ctx.sessionManager.getSessionDir()}${sessionFile ? ` (this session: ${sessionFile})` : ""}.`,
      `- Agent store (Cursor's per-workspace store; orchestrate/, docs/): ${agentStoreDir(home, ctx.cwd)}. Run orch as \`bun ${join(skillsDir, "poteto-mode", "scripts", "orch", "orch.ts")} --store <store>/orchestrate/<project-slug> …\`.`,
      "- Long runs: GoalSet/GoalDone arm and finish a /goal (continued across turns until GoalDone); LoopStart/LoopStop/LoopSchedule run a /loop. Background Task completions arrive as a message that wakes this chat. All of it lives only while this Pi process runs.",
      '- Everything runs locally: an upstream `environment: "cloud"` request runs as the approved local substitute, with no cloud isolation or survive-shutdown guarantee.',
      `- Task runs each subagent as a local Pi child process (nesting: root plus ${MAX_DEPTH} levels). Background tasks return a taskId; check them with TaskStatus / TaskOutput (wait: true blocks) and stop them with TaskCancel, never by resuming. \`readonly\` restricts tools; it is not a sandbox. \`isolation: "worktree"\` runs in a fresh git worktree. Background tasks end when this Pi process exits.`,
      "- Bugbot is an external GitHub product, not a tool here.",
      "- Cursor's built-in `create-skill` is provided as this package's `create-skill` skill (draft / validate / test / iterate and description optimization); load it wherever a pstack skill hands off to create-skill.",
      ...mcpInventory(),
    ].join("\n");
  };

  // ---------- commands ----------
  // Registered at session_start (not at load) so collisions with commands and prompt templates
  // that already exist can be detected and skipped instead of shadowing them.

  let commandsRegistered = false;
  const registerCommands = (ctx: ExtensionContext) => {
    if (commandsRegistered) return;
    commandsRegistered = true;
    const taken = new Set(pi.getCommands().filter((c) => c.source !== "skill").map((c) => c.name.replace(/:\d+$/, "")));
    const tryRegister = (name: string, register: () => void) => {
      if (taken.has(name)) {
        commandCollisions.add(name);
        warn(ctx, `pstack: command "/${name}" already exists; pstack's /${name} is not registered.`);
      } else register();
    };
    tryRegister("pstack", () =>
      pi.registerCommand("pstack", {
        description: "pstack: on | off | status",
        handler: async (args, cmdCtx) => {
          const sub = args.trim();
          if (sub === "on") {
            activate(false, cmdCtx);
            cmdCtx.ui.notify("pstack: active", "info");
          } else if (sub === "off") {
            setState(OFF, cmdCtx);
            stopAllLoops();
            cmdCtx.ui.notify("pstack: off", "info");
          } else if (sub === "status" || sub === "") {
            cmdCtx.ui.notify(statusText(cmdCtx), "info");
          } else {
            cmdCtx.ui.notify("Usage: /pstack on | off | status", "warning");
          }
        },
      }),
    );
    tryRegister("goal", () =>
      pi.registerCommand("goal", {
        description: "pstack: /goal <objective> | pause | resume | clear | done | (status)",
        handler: async (args, cmdCtx) => {
          lastCtx = cmdCtx;
          const sub = args.trim();
          const live = goal && (goal.status === "active" || goal.status === "paused");
          const now = new Date().toISOString();
          if (sub === "" || sub === "status") {
            cmdCtx.ui.notify(`pstack: ${goalStatusText()}`, "info");
          } else if (sub === "pause" || sub === "resume" || sub === "clear" || sub === "done") {
            if (!goal || !live) {
              cmdCtx.ui.notify("pstack: no armed goal", "warning");
              return;
            }
            const status = sub === "pause" ? "paused" : sub === "resume" ? "active" : sub === "clear" ? "cleared" : "done";
            setGoal({ ...goal, status, note: sub === "pause" ? "paused by the user" : undefined, since: now }, cmdCtx);
            cmdCtx.ui.notify(`pstack: ${goalStatusText()}`, "info");
            if (status === "active" && cmdCtx.isIdle()) pi.sendUserMessage(`Continue toward the armed goal: ${goal.objective}`);
          } else {
            armGoal(sub, cmdCtx);
            cmdCtx.ui.notify(`pstack: ${goalStatusText()}`, "info");
            // Start working on it now (Cursor begins the goal immediately).
            pi.sendUserMessage(`Goal: ${sub}`, cmdCtx.isIdle() ? undefined : { deliverAs: "followUp" });
          }
        },
      }),
    );
    tryRegister("loop", () =>
      pi.registerCommand("loop", {
        description: "pstack: /loop [interval] <prompt> | <prompt> every <interval> | list | stop [id|all]",
        handler: async (args, cmdCtx) => {
          lastCtx = cmdCtx;
          const byModel = takeModelDispatch(args.trim() ? `/loop ${args}` : "/loop");
          const text = args.trim();
          if (text === "list") {
            cmdCtx.ui.notify(`pstack loops:\n${loopListText()}`, "info");
            return;
          }
          const stop = /^stop(?:\s+(\S+))?$/.exec(text);
          if (stop) {
            const id = stop[1] ?? "all";
            if (id === "all") {
              const n = loops.size;
              stopAllLoops();
              cmdCtx.ui.notify(`pstack: stopped ${n} loop(s)`, "info");
            } else if (stopLoop(id)) cmdCtx.ui.notify(`pstack: stopped loop ${id}`, "info");
            else cmdCtx.ui.notify(`pstack: no loop "${id}"\n${loopListText()}`, "warning");
            return;
          }
          const parsed = parseLoopArgs(text);
          if ("error" in parsed) {
            cmdCtx.ui.notify(`pstack: ${parsed.error}`, "warning");
            return;
          }
          const loop = startLoop(parsed.prompt, parsed.intervalMs, cmdCtx, byModel);
          cmdCtx.ui.notify(`pstack: loop ${loop.id} started (${formatInterval(loop.intervalMs)}): ${loop.prompt}`, "info");
        },
      }),
    );
    for (const meta of skillMetas) {
      tryRegister(meta.name, () =>
        pi.registerCommand(meta.name, {
          description: `pstack: run skill ${meta.name}`,
          handler: async (args, cmdCtx) => {
            const byModel = takeModelDispatch(args.trim() ? `/${meta.name} ${args}` : `/${meta.name}`);
            if (resolveSkillCommand(meta.name) !== meta.name) {
              cmdCtx.ui.notify(`pstack: Pi does not resolve /skill:${meta.name} to this package's skill (is its skills dir loaded?).`, "error");
              return;
            }
            activateFrom(meta.name === POTETO_SKILL, byModel, cmdCtx);
            const text = args.trim() ? `/skill:${meta.name} ${args.trim()}` : `/skill:${meta.name}`;
            // expandPromptTemplates routes the text through Pi's own /skill: expansion, so the block is identical.
            // The forwarded /skill: input keeps this command's origin.
            if (byModel) markModelDispatch(text);
            pi.sendUserMessage(text, cmdCtx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" });
          },
        }),
      );
    }
  };

  const statusText = (ctx: ExtensionContext): string => {
    const home = pstackHome();
    const report = validateConfigText(readModelsRule(home), lookupFromRegistry(ctx.modelRegistry));
    const current = currentOwnedTools(ctx);
    const lines = [
      `pstack: ${state.active ? "active" : "inactive"}${state.poteto ? " (poteto mode)" : ""}`,
      `tools: ${[...current].join(", ") || "(none)"}`,
      `config: ${modelsRulePath(home)}`,
      formatReport(report),
    ];
    if (toolCollisions.length) lines.push(`tool collisions (not provided): ${toolCollisions.join(", ")}`);
    if (commandCollisions.size) lines.push(`command collisions (not registered): ${[...commandCollisions].map((c) => `/${c}`).join(", ")}`);
    return lines.join("\n");
  };
}

// ---------- AskQuestion (R6) ----------

export type AskQuestionParams = {
  title?: string;
  questions: { id: string; prompt: string; options: { id: string; label: string }[]; allow_multiple?: boolean }[];
};

export type AskQuestionResult =
  | { cancelled: true; answers: { id: string; selected: { id: string; label: string }[] }[] }
  | { cancelled: false; answers: { id: string; selected: { id: string; label: string }[] }[] };

export async function askQuestions(
  params: AskQuestionParams,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<AskQuestionResult> {
  if (!ctx.hasUI) {
    throw new Error("AskQuestion needs an interactive UI, which this session does not have. Ask the user the question in plain text instead.");
  }
  const answers: { id: string; selected: { id: string; label: string }[] }[] = [];
  for (const q of params.questions) {
    const heading = params.title ? `${params.title}\n${q.prompt}` : q.prompt;
    const labels = q.options.map((o, i) => `${i + 1}. ${o.label}`);
    if (!q.allow_multiple) {
      const choice = await ctx.ui.select(heading, labels);
      const index = choice === undefined ? -1 : labels.indexOf(choice);
      if (index === -1) return { cancelled: true, answers };
      answers.push({ id: q.id, selected: [q.options[index] as { id: string; label: string }] });
      continue;
    }
    const picked = new Set<number>();
    const done = "Done";
    for (;;) {
      const shown = labels.map((l, i) => `${picked.has(i) ? "[x]" : "[ ]"} ${l}`);
      const choice = await ctx.ui.select(`${heading}\n(select to toggle, then Done)`, [...shown, done]);
      if (choice === undefined) return { cancelled: true, answers };
      if (choice === done) break;
      const index = shown.indexOf(choice);
      if (index === -1) return { cancelled: true, answers };
      if (picked.has(index)) picked.delete(index);
      else picked.add(index);
    }
    answers.push({ id: q.id, selected: [...picked].sort((a, b) => a - b).map((i) => q.options[i] as { id: string; label: string }) });
  }
  return { cancelled: false, answers };
}

// ---------- pstack_config (R5) ----------

export function runConfigTool(
  params: { action: "read" | "write"; roles?: RoleMap; budget?: string },
  ctx: Pick<ExtensionContext, "modelRegistry">,
): { text: string; details: unknown } {
  const home = pstackHome();
  const path = modelsRulePath(home);
  const lookup = lookupFromRegistry(ctx.modelRegistry);
  if (params.action === "read") {
    const text = readModelsRule(home);
    const report = validateConfigText(text, lookup);
    const parsed = text === undefined ? undefined : parseModelsRule(text);
    const details = { path, exists: text !== undefined, budget: parsed?.budget, roles: parsed?.roles ?? {}, report };
    return { text: `${JSON.stringify({ path, exists: details.exists, budget: details.budget, roles: details.roles }, null, 2)}\n\n${formatReport(report)}`, details };
  }
  if (!params.roles) throw new Error("pstack_config write needs `roles` (the full role -> value map).");
  if (!params.budget || !isBudgetName(params.budget)) {
    throw new Error(`pstack_config write needs \`budget\`, one of: ${Object.keys(BUDGETS).join(", ")}.`);
  }
  const mapped = applyBudget(params.roles, params.budget, lookup);
  const report = validateRoles(mapped.roles, lookup);
  if (mapped.needsChoice.length) {
    throw new Error(`Config not written (${path}): budget mapping needs a choice for ${mapped.needsChoice.map((n) => `${n.role} (${n.reason})`).join(", ")}.\n${formatReport(report)}`);
  }
  if (!report.ok) throw new Error(`Config not written (${path}).\n${formatReport(report)}`);
  writeModelsRule(home, serializeModelsRule(mapped.roles, params.budget));
  const written = validateConfigText(readModelsRule(home), lookup);
  return { text: `Wrote ${path}\n${formatReport({ ...written, warnings: [...report.warnings, ...written.warnings] })}`, details: { path, report: written } };
}

export default function (pi: ExtensionAPI): void {
  pstackExtension(pi);
}
