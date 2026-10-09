// Local Task runtime: each subagent is a `pi --mode json -p` child process with only this package loaded.
// Store layout per task: <PSTACK_HOME>/tasks/<id>/{meta.json,prompt.md,system.md,output.md,events.jsonl,session/}.
// Children are owned by the parent Pi process; nothing survives a parent shutdown (local-only design).

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MAX_DEPTH = 2;
export const READONLY_TOOLS = ["read", "grep", "find", "ls"];
/** Tools this extension provides inside a child; listed explicitly whenever `--tools` restricts the set. */
export const CHILD_PSTACK_TOOLS = [
  "Task", "TaskStatus", "TaskOutput", "TaskCancel", "AskQuestion", "pstack_config",
  "GoalSet", "GoalDone", "LoopStart", "LoopStop", "LoopSchedule",
];
export const CLOUD_NOTE = "cloud requested; ran locally (pi-pstack is local-only)";

export type TaskStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface TaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface TaskMeta {
  id: string;
  parentTaskId?: string;
  parentSessionId: string;
  ownerPid: number;
  pid?: number;
  depth: number;
  description: string;
  subagentType: string;
  /** `provider/id` */
  model: string;
  thinking?: string;
  readonly: boolean;
  background: boolean;
  cwd: string;
  worktree?: { path: string; branch: string };
  environmentNote?: string;
  /** The parent's project-trust decision when the task was created (ctx.isProjectTrusted()). The child gets it
   * as --approve / --no-approve so it loads the same project resources (e.g. `.pi/mcp.json` overrides) as the
   * parent, including a session-only `--approve` that a noninteractive child could not otherwise see. */
  projectTrusted?: boolean;
  status: TaskStatus;
  runs: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  usage: TaskUsage;
  /** Run number whose completion notification was delivered (or suppressed). */
  notifiedRun?: number;
  /** Run number whose settled result the parent already read via TaskOutput / foreground return. */
  consumedRun?: number;
}

export interface AgentType {
  name: string;
  description: string;
  /** Appended to the child system prompt. */
  prompt: string;
  /** `--tools` allowlist; undefined = Pi defaults. */
  tools?: string[];
  readonly?: boolean;
}

export const BUILTIN_AGENT_TYPES: AgentType[] = [
  { name: "generalPurpose", description: "General-purpose agent with the default tools.", prompt: "" },
  {
    name: "explore",
    description: "Read-only codebase exploration.",
    prompt: "You are an exploration agent. Do not modify files.",
    tools: READONLY_TOOLS,
    readonly: true,
  },
  { name: "bash", description: "Shell-command agent.", prompt: "You are a shell agent. Use bash to do the work.", tools: ["bash", "read"] },
  {
    name: "browser",
    description: "Browser tasks (no built-in browser in Pi).",
    prompt:
      "There is no built-in browser tool in this environment. Drive the app through the control-ui skill or command-line tools available on this machine, and say what you could not verify.",
  },
];

/** Package agents (`agents/*.md`): frontmatter `name`, `description`; body is the system prompt. */
export function loadAgentTypes(agentsDir: string): AgentType[] {
  const out = [...BUILTIN_AGENT_TYPES];
  if (!existsSync(agentsDir)) return out;
  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(agentsDir, file), "utf8"));
    const name = typeof frontmatter.name === "string" ? frontmatter.name : basename(file, ".md");
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    out.push({ name, description, prompt: body.trim() });
  }
  return out;
}

export function newTaskId(now = Date.now()): string {
  return `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const tasksRoot = (home: string) => join(home, "tasks");
export const taskDir = (home: string, id: string) => join(tasksRoot(home), id);
export const outputPath = (home: string, id: string) => join(taskDir(home, id), "output.md");

export function writeMeta(home: string, meta: TaskMeta): void {
  const dir = taskDir(home, meta.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `meta.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
  renameSync(tmp, join(dir, "meta.json"));
}

export function readMeta(home: string, id: string): TaskMeta | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(join(taskDir(home, id), "meta.json"), "utf8")) as TaskMeta;
  } catch {
    return undefined;
  }
}

export function listTasks(home: string): TaskMeta[] {
  const root = tasksRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => readMeta(home, id))
    .filter((m): m is TaskMeta => m !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Mark queued/running tasks whose owning Pi process is gone as errors. Persisted pids are never
 * signalled (they may have been reused); orphaned children exit on their own (see watchParent).
 */
export function reconcileOrphans(home: string): TaskMeta[] {
  const fixed: TaskMeta[] = [];
  for (const meta of listTasks(home)) {
    if (meta.status !== "running" && meta.status !== "queued") continue;
    if (meta.ownerPid === process.pid || isAlive(meta.ownerPid)) continue;
    const next = { ...meta, status: "error" as const, error: "parent Pi exited before completion", endedAt: new Date().toISOString() };
    writeMeta(home, next);
    fixed.push(next);
  }
  return fixed;
}

export function readMaxConcurrent(home: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).maxConcurrent;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function childSystemPrompt(meta: TaskMeta, agent: AgentType): string {
  const lines = [
    `You are a pstack subagent (type ${agent.name}, depth ${meta.depth} of max ${MAX_DEPTH}, task id ${meta.id}).`,
    "Your final assistant message is returned verbatim to the parent as the Task result, so end with the complete answer or report.",
    meta.readonly
      ? "Readonly: yes. Do not modify, create or delete files; run only read-only commands. Any Task you launch is readonly too."
      : "Readonly: no.",
    "You do not see the parent's project instructions; the task prompt carries the constraints that apply to you.",
  ];
  if (meta.depth >= MAX_DEPTH) lines.push("You are at the nesting limit: do the work yourself; Task cannot launch further subagents here.");
  if (meta.worktree) lines.push(`You run in an isolated git worktree ${meta.worktree.path} on branch ${meta.worktree.branch}.`);
  return [agent.prompt, lines.join("\n")].filter(Boolean).join("\n\n") + "\n";
}

export interface ChildLaunch {
  extensionPath: string;
  skillsDir: string;
  /** This package's non-vendored skills dir (create-skill), loaded with `--skill` too. */
  extraSkillsDir?: string;
  resume: boolean;
  /** Pi built-in extensions the parent runs that the child should get too (e.g. `mcp`, `codemode`). */
  builtins?: string[];
}

/** Built-ins a child gets when not readonly: Pi's MCP client and codemode (how MCP tools are reached by default). */
export const CHILD_BUILTINS = ["mcp", "codemode"];

/** Arguments after the `pi` command. The prompt is sent on stdin, so it is never parsed as options or `@file`. */
export function buildChildArgs(home: string, meta: TaskMeta, agent: AgentType, launch: ChildLaunch): string[] {
  const dir = taskDir(home, meta.id);
  const args = ["--mode", "json", "-p", "--session-dir", join(dir, "session")];
  if (launch.resume) args.push("-c");
  args.push("--no-extensions", "-e", launch.extensionPath);
  if (meta.projectTrusted !== undefined) args.push(meta.projectTrusted ? "--approve" : "--no-approve");
  // Agent mode keeps MCP (the parent's mcp.json config under the parent's trust decision); readonly strips it, as in Cursor.
  if (!meta.readonly) for (const b of launch.builtins ?? []) args.push("-e", `builtin:${b}`);
  args.push("--no-context-files", "--no-skills", "--skill", launch.skillsDir);
  if (launch.extraSkillsDir) args.push("--skill", launch.extraSkillsDir);
  args.push(
    "--no-prompt-templates",
    "--model", meta.model,
  );
  if (meta.thinking) args.push("--thinking", meta.thinking);
  const tools = meta.readonly ? READONLY_TOOLS : agent.tools;
  if (tools) args.push("--tools", [...tools, ...CHILD_PSTACK_TOOLS].join(","));
  args.push("--append-system-prompt", join(dir, "system.md"));
  return args;
}

export function childEnv(meta: TaskMeta, home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PSTACK_HOME: home,
    PSTACK_DEPTH: String(meta.depth),
    PSTACK_TASK_ID: meta.id,
    PSTACK_PARENT_TASK_ID: meta.parentTaskId ?? "",
    PSTACK_READONLY: meta.readonly ? "1" : "",
    PSTACK_OWNER_PID: String(process.pid),
  };
}

export function defaultPiCommand(): string[] {
  if (process.env.PSTACK_PI_BIN) return [process.env.PSTACK_PI_BIN];
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script) && /(^|[\\/])(pi|cli)(\.[cm]?js)?$/.test(script)) {
    return [process.execPath, script];
  }
  const exec = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exec)) return [process.execPath];
  return ["pi"];
}

/** `git worktree add <home>/worktrees/<id> -b pstack/<id>` from the repo containing `cwd`. */
export function createWorktree(home: string, id: string, cwd: string): { path: string; branch: string } {
  let top: string;
  try {
    top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`isolation "worktree" needs a git repository; ${cwd} is not inside one.`);
  }
  const path = join(home, "worktrees", id);
  const branch = `pstack/${id}`;
  mkdirSync(join(home, "worktrees"), { recursive: true });
  execFileSync("git", ["-C", top, "worktree", "add", "-q", path, "-b", branch, "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
  // Pi reads project MCP policy from <cwd>/.pi/mcp.json. An untracked one in the parent checkout is missing from
  // the fresh worktree, which would let the child connect servers the parent disabled. Copy it when the worktree
  // has none; ignore rules (.gitignore, global, the shared info/exclude) treat it exactly as in the parent.
  const mcp = join(cwd, ".pi", "mcp.json"); // the file the parent's Pi read (its cwd); the child runs at `path`
  const target = join(path, ".pi", "mcp.json");
  if (existsSync(mcp) && !existsSync(target)) {
    mkdirSync(join(path, ".pi"), { recursive: true });
    copyFileSync(mcp, target);
  }
  return { path, branch };
}

/**
 * In a subagent process: exit when the owning parent Pi is gone (crash, SIGKILL), so children never
 * outlive the chat that started them. Polls every `intervalMs`; the timer does not keep Pi alive.
 */
export function watchParent(ownerPid: number, onGone: () => void, intervalMs = 2000): () => void {
  const timer = setInterval(() => {
    if (!isAlive(ownerPid)) {
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RunResult {
  meta: TaskMeta;
  output: string;
  ok: boolean;
}

export interface Progress {
  text: string;
  toolCalls: number;
  usage: TaskUsage;
}

interface Running {
  child?: ChildProcess;
  done: Promise<RunResult>;
  cancel: () => void;
}

const emptyUsage = (): TaskUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
export { emptyUsage };

function lastAssistantText(message: any): string | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
  return text || undefined;
}

/**
 * Owns the child processes of this Pi process. `start` writes the store files, then runs now or queues
 * (FIFO) when `maxConcurrent` is reached. The returned promise settles when the run ends.
 */
export class TaskRunner {
  private running = new Map<string, Running>();
  private queue: Array<{ id: string; run: () => void }> = [];
  private active = 0;

  constructor(
    private readonly home: string,
    private readonly launch: Omit<ChildLaunch, "resume" | "builtins"> & { builtins?: () => string[] },
    private readonly piCommand: () => string[] = defaultPiCommand,
  ) {}

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  wait(id: string): Promise<RunResult> | undefined {
    return this.running.get(id)?.done;
  }

  cancel(id: string): boolean {
    const run = this.running.get(id);
    if (!run) return false;
    run.cancel();
    return true;
  }

  /** Cancel every child and wait (bounded) until each has exited and its meta is settled. */
  async cancelAll(graceMs = 3000): Promise<void> {
    const runs = [...this.running.values()];
    for (const run of runs) run.cancel();
    const all = Promise.all(runs.map((r) => r.done));
    const timedOut = await Promise.race([all.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs).unref())]);
    if (!timedOut) return;
    for (const run of this.running.values()) run.child?.kill("SIGKILL");
    await Promise.race([all, new Promise((r) => setTimeout(r, 1000).unref())]);
  }

  start(meta: TaskMeta, agent: AgentType, prompt: string, resume: boolean, onProgress?: (p: Progress) => void): Promise<RunResult> {
    const dir = taskDir(this.home, meta.id);
    mkdirSync(join(dir, "session"), { recursive: true });
    appendFileSync(join(dir, "prompt.md"), `${resume ? "\n\n---\n\n" : ""}${prompt}\n`);
    writeFileSync(join(dir, "system.md"), childSystemPrompt(meta, agent));
    const max = readMaxConcurrent(this.home);
    let current: TaskMeta = { ...meta, status: "queued", ownerPid: process.pid, error: undefined, exitCode: undefined, endedAt: undefined };
    writeMeta(this.home, current);

    let cancelled = false;
    let child: ChildProcess | undefined;
    let resolveDone!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => (resolveDone = r));
    const entry: Running = {
      done,
      cancel: () => {
        cancelled = true;
        if (child) {
          child.kill("SIGTERM");
          setTimeout(() => child?.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 5000).unref();
        } else {
          this.queue = this.queue.filter((q) => q.id !== meta.id);
          finish(null, "cancelled before start");
        }
      },
    };
    this.running.set(meta.id, entry);

    let output = "";
    let stderr = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let toolCalls = 0;
    const usage = { ...meta.usage };
    let settled = false;

    const finish = (code: number | null, reason?: string) => {
      if (settled) return;
      settled = true;
      this.running.delete(meta.id);
      writeFileSync(join(dir, "output.md"), output);
      let status: TaskStatus = "done";
      let error: string | undefined;
      if (cancelled) {
        status = "cancelled";
        error = reason ?? "cancelled";
      } else if (reason) {
        status = "error";
        error = reason;
      } else if (code !== 0) {
        status = "error";
        error = `child pi exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`;
      } else if (stopReason === "error" || stopReason === "aborted") {
        status = "error";
        error = `subagent stopped (${stopReason})${errorMessage ? `: ${errorMessage}` : ""}`;
      } else if (!output.trim()) {
        status = "error";
        error = "subagent produced no final assistant text";
      }
      current = { ...current, status, error, exitCode: code ?? undefined, endedAt: new Date().toISOString(), usage };
      writeMeta(this.home, current);
      if (child) {
        this.active--;
        this.queue.shift()?.run();
      }
      resolveDone({ meta: current, output, ok: status === "done" });
    };

    const run = () => {
      const [command, ...pre] = this.piCommand();
      const args = [...pre, ...buildChildArgs(this.home, current, agent, { ...this.launch, builtins: this.launch.builtins?.(), resume })];
      this.active++;
      try {
        child = spawn(command!, args, { cwd: current.cwd, env: childEnv(current, this.home), stdio: ["pipe", "pipe", "pipe"] });
        entry.child = child;
        child.stdin!.on("error", () => {});
        child.stdin!.end(prompt);
      } catch (e) {
        child = undefined;
        this.active--;
        finish(null, `could not start pi: ${(e as Error).message}`);
        this.queue.shift()?.run();
        return;
      }
      current = { ...current, status: "running", pid: child.pid, startedAt: new Date().toISOString(), runs: current.runs + 1 };
      writeMeta(this.home, current);
      const events = join(dir, "events.jsonl");
      let buffer = "";
      const onLine = (line: string) => {
        if (!line.trim()) return;
        appendFileSync(events, line + "\n");
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "tool_execution_start") toolCalls++;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const m = event.message;
          usage.turns++;
          usage.input += m.usage?.input ?? 0;
          usage.output += m.usage?.output ?? 0;
          usage.cacheRead += m.usage?.cacheRead ?? 0;
          usage.cacheWrite += m.usage?.cacheWrite ?? 0;
          usage.cost += m.usage?.cost?.total ?? 0;
          stopReason = m.stopReason;
          errorMessage = m.errorMessage;
          const text = lastAssistantText(m);
          if (text !== undefined) output = text;
          else if (m.stopReason === "stop") output = "";
          onProgress?.({ text: output, toolCalls, usage: { ...usage } });
        }
      };
      child.stdout!.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      child.stderr!.on("data", (d) => {
        stderr = (stderr + d.toString()).slice(-8000);
      });
      child.on("error", (e) => finish(null, `could not start pi: ${e.message}`));
      child.on("close", (code) => {
        if (buffer) onLine(buffer);
        finish(code);
      });
    };

    if (max !== undefined && this.active >= max) this.queue.push({ id: meta.id, run });
    else run();
    return done;
  }
}
