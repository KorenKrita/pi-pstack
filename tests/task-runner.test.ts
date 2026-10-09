// Step 3: local Task runtime. A fake `pi` (tests/fixtures/fake-pi.ts) stands in for the child process.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelsRulePath, ROLES, serializeModelsRule, type RoleMap } from "../extensions/pstack/config";
import { pstackExtension } from "../extensions/pstack/index";
import {
  BUILTIN_AGENT_TYPES,
  buildChildArgs,
  childEnv,
  emptyUsage,
  loadAgentTypes,
  readMeta,
  reconcileOrphans,
  writeMeta,
  type TaskMeta,
} from "../extensions/pstack/task-runner";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.ts", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = join(REPO, "skills");

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PSTACK_HOME", "PSTACK_PI_BIN", "PSTACK_DEPTH", "PSTACK_TASK_ID", "PSTACK_READONLY"];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), "pstack-task-"));
  process.env.PSTACK_HOME = home;
  process.env.PSTACK_PI_BIN = FAKE_PI;
  delete process.env.PSTACK_DEPTH;
  delete process.env.PSTACK_TASK_ID;
  delete process.env.PSTACK_READONLY;
  const roles = Object.fromEntries(ROLES.map((r) => [r.name, r.panel ? ["auto"] : "auto"])) as RoleMap;
  mkdirSync(join(home, "rules"), { recursive: true });
  writeFileSync(modelsRulePath(home), serializeModelsRule(roles, "unlimited"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeHost(cwd = tmpdir()) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, ((e: any, c: any) => any)[]>();
  const notes: string[] = [];
  const sentMessages: { message: any; options: any }[] = [];
  const sentUser: { text: string; options: any }[] = [];
  const statuses = new Map<string, string | undefined>();
  let active: string[] = [];
  const branch: any[] = [];
  const extraTools: any[] = [];
  const extraCommands: any[] = [];
  const session: { id: string; idle: boolean; pending: boolean; trusted?: boolean } = { id: "sess-1", idle: true, pending: false };
  const pi: any = {
    on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getAllTools: () => [
      ...[...tools.keys()].map((name) => ({ name, sourceInfo: { path: join(REPO, "extensions/pstack/index.ts") } })),
      ...extraTools,
    ],
    getActiveTools: () => [...active],
    setActiveTools: (n: string[]) => (active = [...n]),
    getCommands: () => extraCommands,
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options: any) => sentUser.push({ text, options }),
    sendMessage: (message: any, options: any) => {
      sentMessages.push({ message, options });
      branch.push({ type: "custom_message", ...message });
    },
    getThinkingLevel: () => "medium",
  };
  const ctx: any = {
    cwd,
    hasUI: false,
    ui: { notify: (m: string) => notes.push(m), setStatus: (k: string, t: string | undefined) => statuses.set(k, t) },
    model: { provider: "anthropic", id: "opus" },
    modelRegistry: {
      find: (p: string, id: string) =>
        p === "anthropic" && id === "opus" ? { provider: p, id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : undefined,
      getAvailable: () => [{ provider: "anthropic", id: "opus", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionId: () => session.id, getBranch: () => branch, getSessionDir: () => "/s", getSessionFile: () => undefined },
    isIdle: () => session.idle,
    isProjectTrusted: () => session.trusted ?? false,
    hasPendingMessages: () => session.pending,
  };
  pstackExtension(pi, { skillsDir: SKILLS });
  const emit = async (e: string, payload: any = {}) => {
    let result: any;
    for (const h of handlers.get(e) ?? []) result = (await h({ type: e, ...payload }, ctx)) ?? result;
    return result;
  };
  const call = (name: string, params: any, signal?: AbortSignal, onUpdate?: (u: any) => void) =>
    tools.get(name).execute("call-1", params, signal, onUpdate, ctx);
  const command = (name: string, args: string) => commands.get(name).handler(args, ctx);
  return { tools, commands, ctx, notes, emit, call, command, session, branch, sentMessages, sentUser, statuses, extraTools, extraCommands, active: () => active };
}

const text = (r: any) => r.content[0].text as string;
const taskIdOf = (r: any) => /taskId: (\S+)/.exec(text(r))![1]!;

function sampleMeta(over: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "tabc",
    parentSessionId: "s",
    ownerPid: process.pid,
    depth: 1,
    description: "d",
    subagentType: "generalPurpose",
    model: "anthropic/opus",
    readonly: false,
    background: false,
    cwd: "/w",
    status: "queued",
    runs: 0,
    createdAt: new Date().toISOString(),
    usage: emptyUsage(),
    ...over,
  };
}

describe("child launch (T1, T2)", () => {
  const launch = { extensionPath: "/pkg/extensions/pstack/index.ts", skillsDir: "/pkg/skills", resume: false };
  const general = BUILTIN_AGENT_TYPES[0]!;

  test("bare pi + this package only, session dir, model and thinking split, system prompt file", () => {
    const args = buildChildArgs("/h", sampleMeta({ thinking: "high" }), general, launch);
    expect(args).toEqual([
      "--mode", "json", "-p", "--session-dir", "/h/tasks/tabc/session",
      "--no-extensions", "-e", "/pkg/extensions/pstack/index.ts",
      "--no-context-files", "--no-skills", "--skill", "/pkg/skills", "--no-prompt-templates",
      "--model", "anthropic/opus", "--thinking", "high",
      "--append-system-prompt", "/h/tasks/tabc/system.md",
    ]);
  });

  test("resume adds -c; readonly restricts tools but keeps pstack tools", () => {
    const args = buildChildArgs("/h", sampleMeta({ readonly: true }), general, { ...launch, resume: true });
    expect(args.slice(0, 6)).toEqual(["--mode", "json", "-p", "--session-dir", "/h/tasks/tabc/session", "-c"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,Task,TaskStatus,TaskOutput,TaskCancel,AskQuestion,pstack_config,GoalSet,GoalDone,LoopStart,LoopStop,LoopSchedule");
    expect(args).not.toContain("--thinking");
  });

  test("agent mode gets the parent's MCP/codemode built-ins; readonly strips them", () => {
    const withMcp = { ...launch, builtins: ["mcp", "codemode"] };
    const agentArgs = buildChildArgs("/h", sampleMeta(), general, withMcp);
    expect(agentArgs.slice(5, 11)).toEqual(["--no-extensions", "-e", "/pkg/extensions/pstack/index.ts", "-e", "builtin:mcp", "-e"]);
    expect(agentArgs).toContain("builtin:codemode");
    const ro = buildChildArgs("/h", sampleMeta({ readonly: true }), general, withMcp);
    expect(ro.filter((a) => a.startsWith("builtin:"))).toEqual([]);
  });

  test("review 5.1: the child gets the parent's project-trust decision for this run (same project MCP config)", () => {
    expect(buildChildArgs("/h", sampleMeta({ projectTrusted: true }), general, launch)).toContain("--approve");
    const untrusted = buildChildArgs("/h", sampleMeta({ projectTrusted: false }), general, launch);
    expect(untrusted).toContain("--no-approve");
    expect(untrusted).not.toContain("--approve");
  });

  test("review 3: readonly removes bash for every agent type", () => {
    for (const agent of BUILTIN_AGENT_TYPES) {
      const args = buildChildArgs("/h", sampleMeta({ readonly: true }), agent, launch);
      expect(args[args.indexOf("--tools") + 1]!.split(",")).not.toContain("bash");
    }
  });

  test("env carries depth, ids and home; agent types include package agents", () => {
    const env = childEnv(sampleMeta({ depth: 2, parentTaskId: "tp", readonly: true }), "/h", {});
    expect(env).toEqual({ PSTACK_HOME: "/h", PSTACK_DEPTH: "2", PSTACK_TASK_ID: "tabc", PSTACK_PARENT_TASK_ID: "tp", PSTACK_READONLY: "1", PSTACK_OWNER_PID: String(process.pid) });
    const names = loadAgentTypes(join(REPO, "agents")).map((a) => a.name);
    expect(names).toEqual(["generalPurpose", "explore", "bash", "browser", "Comment Sicko", "poteto-agent"]);
  });
});

describe("Task tool (T3–T8)", () => {
  test("foreground: final text returned; store has meta, prompt, system, output, events", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const updates: any[] = [];
    const r = await h.call("Task", { description: "greet", prompt: "echo:hello" }, undefined, (u) => updates.push(u));
    expect(text(r)).toBe("hello");
    const meta = readMeta(home, r.details.taskId)!;
    expect(meta).toMatchObject({ status: "done", exitCode: 0, depth: 1, model: "anthropic/opus", thinking: "medium", runs: 1, background: false });
    expect(meta.usage.turns).toBe(1);
    const dir = join(home, "tasks", meta.id);
    expect(readFileSync(join(dir, "output.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe("echo:hello\n");
    expect(readFileSync(join(dir, "system.md"), "utf8")).toContain("You are a pstack subagent (type generalPurpose, depth 1");
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain('"message_end"');
    expect(updates.at(-1).content[0].text).toBe("hello");
  });

  test("child sees depth/task env and runs in the parent cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pstack-cwd-"));
    const h = makeHost(cwd);
    await h.emit("session_start", { reason: "startup" });
    const r = await h.call("Task", { description: "a", prompt: "args" });
    const seen = JSON.parse(text(r));
    expect(seen.env).toMatchObject({ PSTACK_DEPTH: "1", PSTACK_HOME: home, PSTACK_TASK_ID: r.details.taskId });
    expect(seen.cwd.endsWith(cwd.split("/").pop()!)).toBe(true);
  });

  test("review 5.1: the parent's trust decision reaches the child (--approve / --no-approve) and survives resume", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.session.trusted = true;
    const r = await h.call("Task", { description: "t", prompt: "args" });
    expect(JSON.parse(text(r)).args).toContain("--approve");
    h.session.trusted = false;
    const u = await h.call("Task", { description: "u", prompt: "args" });
    expect(JSON.parse(text(u)).args).toContain("--no-approve");
    const again = await h.call("Task", { description: "t again", prompt: "args", resume: r.details.taskId });
    expect(JSON.parse(text(again)).args).toContain("--approve");
  });

  test("review 5.3: builtin:mcp is passed on from its /mcp command before any server has connected", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.extraTools.push({ name: "codemode", sourceInfo: { path: "builtin:codemode" } });
    h.extraCommands.push({ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } });
    const r = await h.call("Task", { description: "m", prompt: "args" });
    const args: string[] = JSON.parse(text(r)).args;
    expect(args).toContain("builtin:mcp");
    expect(args).toContain("builtin:codemode");
  });

  test("failures are errors, never success: exit code, stopReason error, empty output", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    await expect(h.call("Task", { description: "f", prompt: "fail" })).rejects.toThrow(/exited with code 3: boom/);
    await expect(h.call("Task", { description: "e", prompt: "error" })).rejects.toThrow(/stopped \(error\): upstream 502/);
    await expect(h.call("Task", { description: "n", prompt: "empty" })).rejects.toThrow(/no final assistant text/);
  });

  test("foreground abort cancels the child", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const ac = new AbortController();
    const p = h.call("Task", { description: "slow", prompt: "sleep:5000" }, ac.signal);
    await Bun.sleep(300);
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
  });

  test("background: returns at once; TaskStatus never resumes; TaskOutput wait returns the result", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const r = await h.call("Task", { description: "bg", prompt: "sleep:400", run_in_background: true });
    const id = taskIdOf(r);
    expect(text(r)).toContain("status: running in background");
    expect(text(await h.call("TaskOutput", { taskId: id }))).toContain("Still running");
    expect(text(await h.call("TaskStatus", {}))).toContain(`${id} [running] bg`);
    const out = await h.call("TaskOutput", { taskId: id, wait: true, timeoutSeconds: 10 });
    expect(text(out)).toBe("done");
    expect(readMeta(home, id)!.status).toBe("done");
    expect(text(await h.call("TaskOutput", { taskId: id }))).toBe("done");
  });

  test("TaskOutput wait times out without killing the task; TaskCancel cancels it", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const id = taskIdOf(await h.call("Task", { description: "bg", prompt: "sleep:5000", run_in_background: true }));
    expect(text(await h.call("TaskOutput", { taskId: id, wait: true, timeoutSeconds: 0.2 }))).toContain("Still running (timeout)");
    const c = await h.call("TaskCancel", { taskId: id });
    expect(text(c)).toContain("Cancelled.");
    expect(readMeta(home, id)!.status).toBe("cancelled");
    expect(text(await h.call("TaskCancel", { taskId: id }))).toContain("is not running");
  });

  test("maxConcurrent queues excess spawns FIFO", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ maxConcurrent: 1 }));
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const a = taskIdOf(await h.call("Task", { description: "a", prompt: "sleep:300", run_in_background: true }));
    const b = taskIdOf(await h.call("Task", { description: "b", prompt: "echo:b", run_in_background: true }));
    expect(readMeta(home, a)!.status).toBe("running");
    expect(readMeta(home, b)!.status).toBe("queued");
    expect(text(await h.call("TaskOutput", { taskId: b, wait: true, timeoutSeconds: 10 }))).toBe("b");
    expect(Date.parse(readMeta(home, b)!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(readMeta(home, a)!.endedAt!));
  });

  test("no limit by default: two background tasks run at once", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const a = taskIdOf(await h.call("Task", { description: "a", prompt: "sleep:300", run_in_background: true }));
    const b = taskIdOf(await h.call("Task", { description: "b", prompt: "sleep:300", run_in_background: true }));
    expect([readMeta(home, a)!.status, readMeta(home, b)!.status]).toEqual(["running", "running"]);
    await h.call("TaskOutput", { taskId: a, wait: true });
    await h.call("TaskOutput", { taskId: b, wait: true });
  });

  test("resume continues the same session dir with -c; refused while running; unknown id refused", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const first = await h.call("Task", { description: "mem", prompt: "echo:first" });
    const id = first.details.taskId;
    const again = await h.call("Task", { description: "mem", prompt: "remember", resume: id });
    expect(text(again)).toBe("prior=1 first=echo:first");
    expect(readMeta(home, id)!.runs).toBe(2);
    expect(readFileSync(join(home, "tasks", id, "prompt.md"), "utf8")).toContain("echo:first\n\n\n---\n\nremember");

    const bg = taskIdOf(await h.call("Task", { description: "bg", prompt: "sleep:2000", run_in_background: true }));
    await expect(h.call("Task", { description: "x", prompt: "p", resume: bg })).rejects.toThrow(/still running; read its status/);
    await h.call("TaskCancel", { taskId: bg });
    await expect(h.call("Task", { description: "x", prompt: "p", resume: "tnope" })).rejects.toThrow(/Unknown task "tnope"/);
  });

  test("depth limit: a depth-2 process cannot spawn; children start active", async () => {
    process.env.PSTACK_DEPTH = "2";
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    expect(h.active()).toContain("Task");
    await expect(h.call("Task", { description: "deep", prompt: "echo:x" })).rejects.toThrow(/nesting limit/);
    process.env.PSTACK_DEPTH = "1";
    const h1 = makeHost();
    await h1.emit("session_start", { reason: "startup" });
    const r = await h1.call("Task", { description: "lvl2", prompt: "args" });
    expect(JSON.parse(text(r)).env.PSTACK_DEPTH).toBe("2");
  });

  test("subagent types: package agent prompt appended; unknown type lists available; explore is readonly", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const r = await h.call("Task", { description: "p", prompt: "echo:ok", subagent_type: "poteto-agent" });
    expect(readFileSync(join(home, "tasks", r.details.taskId, "system.md"), "utf8")).toContain("# Poteto subagent");
    await expect(h.call("Task", { description: "u", prompt: "p", subagent_type: "nope" })).rejects.toThrow(/Available: generalPurpose, explore, bash, browser, Comment Sicko, poteto-agent/);
    const e = JSON.parse(text(await h.call("Task", { description: "e", prompt: "args", subagent_type: "explore" })));
    expect(e.args[e.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,Task,TaskStatus,TaskOutput,TaskCancel,AskQuestion,pstack_config,GoalSet,GoalDone,LoopStart,LoopStop,LoopSchedule");
    expect(e.env.PSTACK_READONLY).toBe("1");
    const b = JSON.parse(text(await h.call("Task", { description: "b", prompt: "args", subagent_type: "bash", readonly: true })));
    expect(b.args[b.args.indexOf("--tools") + 1]).not.toContain("bash");
    const nb = JSON.parse(text(await h.call("Task", { description: "b", prompt: "args", subagent_type: "bash" })));
    expect(nb.args[nb.args.indexOf("--tools") + 1]).toContain("bash");
  });

  test("review 4: prompts go on stdin verbatim, even ones that look like options or @files", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    for (const p of ["- Review src/index.ts\n- Do not edit", "@src/index.ts", "--help"]) {
      const r = await h.call("Task", { description: "p", prompt: `echo:${p}` });
      expect(text(r)).toBe(p);
      const args = JSON.parse(readFileSync(join(home, "tasks", r.details.taskId, "events.jsonl"), "utf8").split("\n")[0]!);
      expect(args.type).toBe("session");
    }
    const seen = JSON.parse(text(await h.call("Task", { description: "a", prompt: "args" })));
    expect(seen.args.at(-1)).toBe(join(home, "tasks", seen.env.PSTACK_TASK_ID, "system.md"));
  });

  test("review 5: resume recomputes depth and parent from the current caller", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const id = (await h.call("Task", { description: "r", prompt: "echo:x" })).details.taskId;
    process.env.PSTACK_DEPTH = "1";
    process.env.PSTACK_TASK_ID = "tcaller";
    const r = JSON.parse(text(await h.call("Task", { description: "r", prompt: "args", resume: id })));
    expect(r.env.PSTACK_DEPTH).toBe("2");
    expect(r.env.PSTACK_PARENT_TASK_ID).toBe("tcaller");
    expect(readMeta(home, id)).toMatchObject({ depth: 2, parentTaskId: "tcaller" });
    process.env.PSTACK_DEPTH = "2";
    await expect(h.call("Task", { description: "r", prompt: "echo:x", resume: id })).rejects.toThrow(/nesting limit/);
  });

  test("review 6: tasks owned by another process: wait follows the store; cancel says who owns it", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    writeMeta(home, sampleMeta({ id: "tother", status: "running", ownerPid: process.ppid, parentTaskId: "tp" }));
    await expect(h.call("TaskCancel", { taskId: "tother" })).rejects.toThrow(/owned by another Pi process.*\(tp\)/);
    const waiting = h.call("TaskOutput", { taskId: "tother", wait: true, timeoutSeconds: 10 });
    await Bun.sleep(300);
    writeFileSync(join(home, "tasks", "tother", "output.md"), "theirs");
    writeMeta(home, { ...readMeta(home, "tother")!, status: "done" });
    expect(text(await waiting)).toBe("theirs");
  });

  test("cross-process wait stops polling at its deadline and on an already-aborted signal", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    writeMeta(home, sampleMeta({ id: "tother", status: "running", ownerPid: process.ppid }));
    // Count the poller's 500ms sleeps: after the call returns, none may be scheduled.
    const realSetTimeout = globalThis.setTimeout;
    let polls = 0;
    (globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      if (ms !== undefined && ms > 0 && ms <= 500) polls++;
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      const t0 = Date.now();
      expect(text(await h.call("TaskOutput", { taskId: "tother", wait: true, timeoutSeconds: 0.3 }))).toContain("Still running (timeout)");
      expect(Date.now() - t0).toBeLessThan(2000);
      const after = polls;
      await Bun.sleep(1200);
      expect(polls).toBe(after);
      const ac = new AbortController();
      ac.abort();
      expect(text(await h.call("TaskOutput", { taskId: "tother", wait: true, timeoutSeconds: 30 }, ac.signal))).toContain("Still running (aborted)");
      const afterAbort = polls;
      await Bun.sleep(700);
      expect(polls).toBe(afterAbort);
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }
  });

  test("failed and cancelled results are tool errors (thrown), from TaskOutput poll and wait", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const bg = taskIdOf(await h.call("Task", { description: "f", prompt: "fail", run_in_background: true }));
    await expect(h.call("TaskOutput", { taskId: bg, wait: true })).rejects.toThrow(/exited with code 3/);
    await expect(h.call("TaskOutput", { taskId: bg })).rejects.toThrow(/exited with code 3/);
    writeMeta(home, sampleMeta({ id: "tcan", status: "cancelled", error: "cancelled" }));
    await expect(h.call("TaskOutput", { taskId: "tcan" })).rejects.toThrow(/tcan cancelled/);
  });

  test("review 7: a queued background task is reported as queued", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ maxConcurrent: 1 }));
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const a = await h.call("Task", { description: "a", prompt: "sleep:300", run_in_background: true });
    const b = await h.call("Task", { description: "b", prompt: "echo:b", run_in_background: true });
    expect([a.details.status, b.details.status]).toEqual(["running", "queued"]);
    expect(text(b)).toContain("status: queued in background");
    await h.call("TaskOutput", { taskId: b.details.taskId, wait: true });
  });

  test("review 2: shutdown waits for children, escalating to SIGKILL, and settles their meta", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const id = (await h.call("Task", { description: "s", prompt: "ignore-term", run_in_background: true })).details.taskId;
    await Bun.sleep(400);
    const pid = readMeta(home, id)!.pid!;
    const t0 = Date.now();
    await h.emit("session_shutdown", {});
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(readMeta(home, id)!.status).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);

  test("cloud runs locally with a note", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const r = await h.call("Task", { description: "c", prompt: "echo:hi", environment: "cloud" });
    expect(text(r)).toBe("environment_note: cloud requested; ran locally (pi-pstack is local-only)\n\nhi");
  });

  test("worktree isolation: child runs in a new worktree on pstack/<id>; non-repo is an error", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pstack-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const h = makeHost(repo);
    await h.emit("session_start", { reason: "startup" });
    const r = await h.call("Task", { description: "w", prompt: "args", isolation: "worktree" });
    const id = r.details.taskId;
    const meta = readMeta(home, id)!;
    expect(meta.worktree).toEqual({ path: join(home, "worktrees", id), branch: `pstack/${id}` });
    expect(existsSync(join(home, "worktrees", id, ".git"))).toBe(true);
    expect(text(r)).toContain(`worktree: ${join(home, "worktrees", id)}`);
    const h2 = makeHost(mkdtempSync(join(tmpdir(), "pstack-norepo-")));
    await h2.emit("session_start", { reason: "startup" });
    await expect(h2.call("Task", { description: "w", prompt: "p", isolation: "worktree" })).rejects.toThrow(/needs a git repository/);
  });

  test("unconfigured Task still refuses before spawning", async () => {
    writeFileSync(modelsRulePath(home), "");
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    await expect(h.call("Task", { description: "d", prompt: "echo:x" })).rejects.toThrow(/pstack is not configured/);
    expect(existsSync(join(home, "tasks"))).toBe(false);
  });
});

describe("orphans (T5)", () => {
  test("running tasks whose owner Pi is gone become errors at session_start", async () => {
    const dead = 2 ** 22 + 12345;
    const kills: unknown[] = [];
    const realKill = process.kill;
    // Review 1: a live process at the stored child pid (pid reuse) must not be signalled.
    writeMeta(home, sampleMeta({ id: "treuse", status: "running", ownerPid: dead, pid: process.pid }));
    (process as any).kill = (pid: number, sig?: unknown) => (sig === 0 || sig === undefined ? realKill(pid, 0 as any) : kills.push([pid, sig]), true);
    try {
      expect(reconcileOrphans(home).map((m) => m.id)).toEqual(["treuse"]);
    } finally {
      (process as any).kill = realKill;
    }
    expect(kills).toEqual([]);
    writeMeta(home, sampleMeta({ id: "torph", status: "running", ownerPid: dead, pid: dead + 1 }));
    writeMeta(home, sampleMeta({ id: "tmine", status: "running", ownerPid: process.pid }));
    expect(reconcileOrphans(home).map((m) => m.id)).toEqual(["torph"]);
    expect(readMeta(home, "torph")).toMatchObject({ status: "error", error: "parent Pi exited before completion" });
    expect(readMeta(home, "tmine")!.status).toBe("running");
    const h = makeHost();
    writeMeta(home, sampleMeta({ id: "torph2", status: "queued", ownerPid: dead }));
    await h.emit("session_start", { reason: "startup" });
    expect(h.notes.some((n) => n.includes("torph2"))).toBe(true);
  });
});

describe("background completion notifications (Step 4 N1)", () => {
  // Tasks are only started while pstack is active (a skill or /pstack on activates it).
  const started = async (h: ReturnType<typeof makeHost>, prompt: string) => {
    if (!h.active().includes("Task")) await h.command("pstack", "on");
    return taskIdOf(await h.call("Task", { description: "bg", prompt, run_in_background: true }));
  };
  const settle = async (h: ReturnType<typeof makeHost>, id: string) => {
    while (["running", "queued"].includes(readMeta(home, id)!.status)) await Bun.sleep(20);
    await Bun.sleep(20);
  };
  const doneMessages = (h: ReturnType<typeof makeHost>) => h.sentMessages.filter((m) => m.message.customType === "pstack-task-done");

  test("idle: one message that starts a turn, with status and output", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    const id = await started(h, "echo:ripe");
    await settle(h, id);
    const msgs = doneMessages(h);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(msgs[0]!.message.content).toContain(`Background Task ${id} (bg) finished: done.`);
    expect(msgs[0]!.message.content).toContain("ripe");
    expect(msgs[0]!.message.details).toEqual({ taskId: id, runs: 1, status: "done" });
    expect(readMeta(home, id)!.notifiedRun).toBe(1);
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(1);
  });

  test("busy: held until agent_settled; errors notify; cancelled does not", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.session.idle = false;
    const failed = await started(h, "fail");
    await settle(h, failed);
    expect(doneMessages(h)).toHaveLength(0);
    h.session.idle = true;
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(1);
    expect(doneMessages(h)[0]!.message.content).toContain("finished: error.");
    const slow = await started(h, "sleep:3000");
    await Bun.sleep(200);
    await h.call("TaskCancel", { taskId: slow });
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(1);
  });

  test("result read through TaskOutput before delivery: no notification", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.session.idle = false;
    const id = await started(h, "echo:x");
    expect(text(await h.call("TaskOutput", { taskId: id, wait: true }))).toBe("x");
    h.session.idle = true;
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(0);
    expect(readMeta(home, id)!.consumedRun).toBe(1);
  });

  test("/pstack off before delivery suppresses it", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.session.idle = false;
    const id = await started(h, "echo:x");
    await settle(h, id);
    await h.command("pstack", "off");
    h.session.idle = true;
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(0);
    expect(readMeta(home, id)!.notifiedRun).toBe(1);
  });

  test("session switch: another chat gets nothing; the starting chat gets it on return", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    h.session.idle = false;
    const id = await started(h, "echo:x");
    await settle(h, id);
    h.session.id = "sess-2";
    h.session.idle = true;
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(0);
    h.session.id = "sess-1";
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(1);
  });

  test("restart: undelivered settled runs are delivered once at session_start; branch copy dedupes", async () => {
    writeMeta(home, sampleMeta({ id: "tlost", parentSessionId: "sess-1", background: true, status: "done", runs: 1 }));
    writeFileSync(join(home, "tasks", "tlost", "output.md"), "late");
    writeMeta(home, sampleMeta({ id: "tseen", parentSessionId: "sess-1", background: true, status: "done", runs: 1 }));
    const h = makeHost();
    h.branch.push({ type: "custom_message", customType: "pstack-task-done", details: { taskId: "tseen", runs: 1 } });
    h.branch.push({ type: "custom", customType: "pstack-state", data: { active: true, poteto: false } });
    await h.emit("session_start", { reason: "resume" });
    expect(doneMessages(h).map((m) => m.message.details.taskId)).toEqual(["tlost"]);
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(1);
  });

  test("a foreground result is never notified", async () => {
    const h = makeHost();
    await h.emit("session_start", { reason: "startup" });
    await h.call("Task", { description: "fg", prompt: "echo:x" });
    await h.emit("agent_settled", { aborted: false });
    expect(doneMessages(h)).toHaveLength(0);
  });
});
