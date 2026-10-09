// Step 4: /goal and /loop (pure logic in long-run.ts, wiring through a fake host).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pstackExtension } from "../extensions/pstack/index";
import {
  GOAL_CONTINUE_MESSAGE,
  decideGoalSettle,
  formatInterval,
  goalFromBranch,
  loopsFromBranch,
  parseInterval,
  parseLoopArgs,
  type Goal,
} from "../extensions/pstack/long-run";

const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));
const EXT = fileURLToPath(new URL("../extensions/pstack/index.ts", import.meta.url));

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.PSTACK_HOME;
  process.env.PSTACK_HOME = mkdtempSync(join(tmpdir(), "pstack-lr-"));
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.PSTACK_HOME;
  else process.env.PSTACK_HOME = savedHome;
});

function host() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, ((e: any, c: any) => any)[]>();
  const branch: any[] = [];
  const sentUser: { text: string; options: any }[] = [];
  const sentMessages: any[] = [];
  const notes: string[] = [];
  const statuses = new Map<string, string | undefined>();
  let active: string[] = [];
  const session = { id: "s1", idle: true, pending: false };
  const pi: any = {
    on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (n: string, o: any) => commands.set(n, o),
    getAllTools: () => [...tools.keys()].map((name) => ({ name, sourceInfo: { path: EXT } })),
    getActiveTools: () => [...active],
    setActiveTools: (n: string[]) => (active = [...n]),
    getCommands: () => [],
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options: any) => sentUser.push({ text, options }),
    sendMessage: (m: any) => sentMessages.push(m),
    getThinkingLevel: () => "off",
  };
  const ctx: any = {
    cwd: tmpdir(),
    hasUI: false,
    ui: { notify: (m: string) => notes.push(m), setStatus: (k: string, t: string | undefined) => statuses.set(k, t) },
    modelRegistry: { find: () => undefined, getAvailable: () => [], hasConfiguredAuth: () => false },
    sessionManager: { getSessionId: () => session.id, getBranch: () => branch, getSessionDir: () => "/s", getSessionFile: () => undefined },
    isIdle: () => session.idle,
    hasPendingMessages: () => session.pending,
  };
  pstackExtension(pi, { skillsDir: SKILLS });
  const emit = async (e: string, payload: any = {}) => {
    let result: any;
    for (const h of handlers.get(e) ?? []) result = (await h({ type: e, ...payload }, ctx)) ?? result;
    return result;
  };
  const command = (n: string, a: string) => commands.get(n).handler(a, ctx);
  const call = (n: string, p: any) => tools.get(n).execute("c", p, undefined, undefined, ctx);
  const settle = (outcome = "completed", extra: any = {}) => emit("agent_before_settle", { outcome, continue: false, entries: [], ...extra });
  const turn = async () => {
    const o = { sections: {} as Record<string, string> };
    await emit("before_agent_start", { prompt: "x", systemPromptOptions: o });
    return o.sections;
  };
  return { tools, commands, branch, sentUser, sentMessages, notes, statuses, session, emit, command, call, settle, turn, ctx, active: () => active };
}

const goalOf = (h: ReturnType<typeof host>) => goalFromBranch(h.branch);

describe("goal decision (pure)", () => {
  const g: Goal = { objective: "x", status: "active", since: "" };
  const base = { goal: g, pstackActive: true, outcome: "completed" as const, alreadyContinuing: false, pendingInput: false };
  test("continues a normally ended run, with no cap", () => {
    for (let i = 0; i < 100; i++) expect(decideGoalSettle(base)).toEqual({ kind: "continue" });
  });
  test("abort and error pause; other continuations and queued input are respected; inactive does nothing", () => {
    expect(decideGoalSettle({ ...base, outcome: "aborted" }).kind).toBe("pause");
    expect(decideGoalSettle({ ...base, outcome: "error" }).kind).toBe("pause");
    expect(decideGoalSettle({ ...base, alreadyContinuing: true })).toEqual({ kind: "none" });
    expect(decideGoalSettle({ ...base, pendingInput: true })).toEqual({ kind: "none" });
    expect(decideGoalSettle({ ...base, pstackActive: false })).toEqual({ kind: "none" });
    expect(decideGoalSettle({ ...base, goal: { ...g, status: "paused" } })).toEqual({ kind: "none" });
    expect(decideGoalSettle({ ...base, goal: undefined })).toEqual({ kind: "none" });
  });
});

describe("/goal wiring", () => {
  test("/goal <objective> arms, activates pstack (not poteto), injects the section, starts work", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("goal", "ship the parser");
    expect(goalOf(h)).toMatchObject({ objective: "ship the parser", status: "active" });
    expect(h.active()).toContain("GoalDone");
    expect(h.branch.filter((e) => e.customType === "pstack-state").at(-1).data).toEqual({ active: true, poteto: false });
    expect((await h.turn()).pstack_goal).toContain("Armed goal (/goal): ship the parser");
    expect(h.sentUser.at(-1)!.text).toBe("Goal: ship the parser");
    expect(h.statuses.get("pstack-goal")).toBe("goal active: ship the parser");
  });

  test("before_settle continues until GoalDone; then stops", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("goal", "g");
    const r = await h.settle();
    expect(r.continue).toBe(true);
    expect(r.entries[0]).toMatchObject({ type: "custom_message", customType: GOAL_CONTINUE_MESSAGE, display: false });
    expect((await h.settle()).continue).toBe(true);
    await h.call("GoalDone", { summary: "tests green" });
    expect(goalOf(h)).toMatchObject({ status: "done", note: "tests green" });
    expect(await h.settle()).toBeUndefined();
    expect((await h.turn()).pstack_goal).toBeUndefined();
  });

  test("abort pauses; a user message resumes; a command does not", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("goal", "g");
    expect(await h.settle("aborted")).toBeUndefined();
    expect(goalOf(h)!.status).toBe("paused");
    await h.emit("input", { text: "/goal status", source: "interactive" });
    expect(goalOf(h)!.status).toBe("paused");
    await h.emit("input", { text: "keep going", source: "interactive" });
    expect(goalOf(h)!.status).toBe("active");
  });

  test("error pauses with a note; blocked GoalDone pauses with the question", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("goal", "g");
    await h.settle("error");
    expect(goalOf(h)).toMatchObject({ status: "paused", note: "paused: the run ended with an error" });
    await h.command("goal", "resume");
    expect(goalOf(h)!.status).toBe("active");
    await h.call("GoalDone", { summary: "which DB?", blocked: true });
    expect(goalOf(h)).toMatchObject({ status: "paused", note: "which DB?" });
    expect(await h.settle()).toBeUndefined();
  });

  test("does not override another continuation or queued input; /pstack off stops continuing", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("goal", "g");
    expect(await h.settle("completed", { continue: true })).toBeUndefined();
    h.session.pending = true;
    expect(await h.settle()).toBeUndefined();
    h.session.pending = false;
    await h.command("pstack", "off");
    expect(await h.settle()).toBeUndefined();
  });

  test("GoalSet arms from the model; state follows the branch on session_start", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("pstack", "on");
    await h.call("GoalSet", { objective: "from model" });
    expect(goalOf(h)!.status).toBe("active");
    const h2 = host();
    h2.branch.push(...h.branch);
    await h2.emit("session_start", { reason: "resume" });
    expect((await h2.settle()).continue).toBe(true);
    await h.command("goal", "clear");
    expect(goalOf(h)!.status).toBe("cleared");
    await expect(h.call("GoalDone", { summary: "x" })).rejects.toThrow(/No armed goal/);
  });
});

describe("loop parsing (pure)", () => {
  test("intervals", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("5 minutes")).toBe(300_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(parseInterval("5x")).toBeUndefined();
  });
  test("leading, trailing, dynamic, errors", () => {
    expect(parseLoopArgs("5m /how the parser")).toEqual({ prompt: "/how the parser", intervalMs: 300_000 });
    expect(parseLoopArgs("check CI every 2h")).toEqual({ prompt: "check CI", intervalMs: 7_200_000 });
    expect(parseLoopArgs("watch the deploy")).toEqual({ prompt: "watch the deploy" });
    expect(parseLoopArgs("5 apples please")).toEqual({ prompt: "5 apples please" });
    expect("error" in parseLoopArgs("")).toBe(true);
    expect("error" in parseLoopArgs("10s x")).toBe(true);
    expect(formatInterval(1_800_000)).toBe("30m");
  });
  test("loopsFromBranch: add/stop/schedule, other sessions ignored", () => {
    const add = (id: string, sessionId = "s1") => ({ type: "custom", customType: "pstack-loop", data: { op: "add", loop: { id, prompt: "p", sessionId, createdAt: "" } } });
    const entries = [add("a"), add("b"), add("c", "s2"), { type: "custom", customType: "pstack-loop", data: { op: "stop", id: "a" } }, { type: "custom", customType: "pstack-loop", data: { op: "schedule", id: "b", nextAt: 5 } }];
    expect(loopsFromBranch(entries, "s1")).toEqual([{ loop: { id: "b", prompt: "p", sessionId: "s1", createdAt: "" }, nextAt: 5 }]);
  });
});

describe("/loop wiring", () => {
  // Shrink timers: every setTimeout delay is divided by 1000 so 30s ticks take 30ms.
  const realSetTimeout = globalThis.setTimeout;
  beforeEach(() => {
    (globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => realSetTimeout(fn, ms ? ms / 1000 : ms, ...rest);
  });
  afterEach(() => {
    (globalThis as any).setTimeout = realSetTimeout;
  });
  const wait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

  test("fixed loop: ticks now and every interval with the prompt unchanged; stop ends it", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("loop", "30s /how the parser");
    await wait(5);
    expect(h.sentUser.map((s) => s.text)).toEqual(["/how the parser"]);
    expect(h.sentUser[0]!.options).toEqual({ expandPromptTemplates: true });
    expect(h.sentMessages[0]).toMatchObject({ customType: "pstack-loop-tick", display: true });
    await wait(70);
    expect(h.sentUser.length).toBeGreaterThanOrEqual(3);
    await h.command("loop", "stop");
    const n = h.sentUser.length;
    await wait(80);
    expect(h.sentUser.length).toBe(n);
  });

  test("busy at tick time: skipped, then fired once at agent_settled", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("loop", "30s check");
    await wait(5);
    h.session.idle = false;
    await wait(100);
    expect(h.sentUser).toHaveLength(1);
    h.session.idle = true;
    await h.emit("agent_settled", { aborted: false });
    expect(h.sentUser).toHaveLength(2);
    await h.command("loop", "stop all");
  });

  test("dynamic loop: next tick from LoopSchedule, default 10 min otherwise", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("loop", "watch the deploy");
    await wait(5);
    expect(h.sentUser).toHaveLength(1);
    const id = h.branch.find((e) => e.customType === "pstack-loop").data.loop.id;
    await h.call("LoopSchedule", { loopId: id, delaySeconds: 40 });
    await h.emit("agent_settled", { aborted: false });
    await wait(60);
    expect(h.sentUser).toHaveLength(2);
    await h.emit("agent_settled", { aborted: false });
    await wait(100);
    expect(h.sentUser).toHaveLength(2);
    await wait(560);
    expect(h.sentUser).toHaveLength(3);
    await h.call("LoopStop", { loopId: "all" });
  });

  test("/pstack off stops loops; re-armed on session_start from the branch", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("loop", "1m tick");
    await wait(5);
    const h2 = host();
    h2.branch.push(...h.branch);
    await h.command("pstack", "off");
    const n = h.sentUser.length;
    await wait(150);
    expect(h.sentUser.length).toBe(n);
    // h2 resumes the session before the stop entry: its loop re-arms.
    h2.branch.push({ type: "custom", customType: "pstack-state", data: { active: true, poteto: false } });
    await h2.emit("session_start", { reason: "resume" });
    await wait(150);
    expect(h2.sentUser.length).toBeGreaterThanOrEqual(1);
    await h2.command("loop", "stop");
  });

  test("model can start a loop with LoopStart", async () => {
    const h = host();
    await h.emit("session_start", { reason: "startup" });
    await h.command("pstack", "on");
    const r = await h.call("LoopStart", { prompt: "audit tick", intervalSeconds: 1800 });
    expect(r.content[0].text).toMatch(/Loop l\w+ started \(30m\)/);
    await wait(5);
    expect(h.sentUser.at(-1)!.text).toBe("audit tick");
    await h.call("LoopStop", { loopId: "all" });
  });
});
