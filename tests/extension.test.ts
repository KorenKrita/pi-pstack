import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { loadAlwaysApplyRules } from "../extensions/pstack/rules";
import { ROLES, modelsRulePath } from "../extensions/pstack/config";
const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.ts", import.meta.url));
import {
  POTETO_GRANT,
  STATE_ENTRY,
  askQuestions,
  pstackExtension,
  runConfigTool,
  stateFromBranch,
} from "../extensions/pstack/index";

const REPO_SKILLS = join(import.meta.dir, "../skills");
const POTETO_REMINDER = "New task? Playbook match or rigor needed -> apply /poteto-mode.";

// ---------- fakes ----------

type Handler = (event: any, ctx: any) => any;
type Model = { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> };

const MODELS: Model[] = [
  { provider: "anthropic", id: "opus", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "local", id: "plain", reasoning: false },
];

function fakeRegistry(models: Model[] = MODELS) {
  return {
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
    hasConfiguredAuth: () => true,
    getAvailable: () => models,
  };
}

interface FakeOptions {
  /** Tools/commands registered by other extensions before pstack. */
  otherTools?: string[];
  otherCommands?: string[];
  /** Skill commands as Pi's resource loader reports them: name → SKILL.md path. */
  skillCommands?: Record<string, string>;
  skillsDir?: string;
  extraSkillsDir?: string;
}

function makePi(opts: FakeOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const lateTools = new Map<string, any>();
  const ownExtensionPath = fileURLToPath(new URL("../extensions/pstack/index.ts", import.meta.url));
  const commands = new Map<string, any>();
  let active = ["read", "bash", ...(opts.otherTools ?? [])];
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  const sent: { text: string; options: unknown }[] = [];
  const notes: { message: string; type?: string }[] = [];
  const skillCommands = opts.skillCommands ?? {
    how: join(REPO_SKILLS, "how/SKILL.md"),
    "poteto-mode": join(REPO_SKILLS, "poteto-mode/SKILL.md"),
    "setup-pstack": join(REPO_SKILLS, "setup-pstack/SKILL.md"),
  };

  const pi: any = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) active.push(tool.name);
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getAllTools: () => [
      ...(opts.otherTools ?? []).map((name) => ({ name, sourceInfo: { path: "/other/ext.ts" } })),
      ...[...tools.keys()].map((name) => ({ name, sourceInfo: { path: ownExtensionPath } })),

      ...[...lateTools.keys()].map((name) => ({ name, sourceInfo: { path: "/other/late.ts" } })),
    ].filter((tool) => !lateTools.has(tool.name) || tool.sourceInfo.path === "/other/late.ts"),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    getCommands: () => [
      ...(opts.otherCommands ?? []).map((name) => ({ name, source: "extension", sourceInfo: { path: "/other/ext.ts" } })),
      ...[...commands.keys()].map((name) => ({ name, source: "extension", sourceInfo: { path: "/pstack/index.ts" } })),
      ...Object.entries(skillCommands).map(([name, path]) => ({ name: `skill:${name}`, source: "skill", sourceInfo: { path } })),
    ],
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
    getThinkingLevel: () => "high",
  };

  const ctx: any = {
    cwd: tmpdir(),
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
    modelRegistry: fakeRegistry(),
    model: { provider: "anthropic", id: "opus" },
    sessionManager: {
      getSessionId: () => "sess-1",
      getBranch: () => branch,
      getSessionDir: () => "/sessions/--work--",
      getSessionFile: () => "/sessions/--work--/s.jsonl",
    },
    isIdle: () => true,
  };

  const emit = async (event: string, payload: any = {}) => {
    let result: any;
    for (const h of handlers.get(event) ?? []) result = (await h({ type: event, ...payload }, ctx)) ?? result;
    return result;
  };

  const turn = async () => {
    const options = { sections: {} as Record<string, string> };
    await emit("before_agent_start", { prompt: "x", systemPromptOptions: options });
    return options.sections;
  };

  pstackExtension(pi, { skillsDir: opts.skillsDir ?? REPO_SKILLS, extraSkillsDir: opts.extraSkillsDir });
  return { pi, ctx, tools, lateTools, commands, branch, sent, notes, emit, turn, active: () => active };
}

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.PSTACK_HOME;
  home = mkdtempSync(join(tmpdir(), "pstack-ext-"));
  process.env.PSTACK_HOME = home;
});
afterEach(() => {
  delete process.env.PSTACK_PI_BIN;
  if (previousHome === undefined) delete process.env.PSTACK_HOME;
  else process.env.PSTACK_HOME = previousHome;
});

const OWNED = ["Task", "TaskStatus", "TaskOutput", "TaskCancel", "AskQuestion", "pstack_config", "GoalSet", "GoalDone", "LoopStart", "LoopStop", "LoopSchedule"];

// ---------- R1 activation ----------

describe("activation (R1)", () => {
  test("tools are registered inactive; /skill:<own> activates without poteto", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    expect([...f.tools.keys()].sort()).toEqual([...OWNED].sort());
    expect(f.active()).toEqual(["read", "bash"]);
    expect(await f.turn()).toEqual({});

    await f.emit("input", { text: "/skill:how explain x", source: "interactive" });
    expect(f.active()).toEqual(["read", "bash", ...OWNED]);
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: false });
  });

  test("/skill:poteto-mode enables poteto mode", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:poteto-mode", source: "interactive" });
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: true });
  });

  test("a same-named skill from another package does not activate", async () => {
    const other = mkdtempSync(join(tmpdir(), "other-pkg-"));
    mkdirSync(join(other, "how"));
    writeFileSync(join(other, "how/SKILL.md"), "---\nname: how\ndescription: x\n---\nbody\n");
    const f = makePi({ skillCommands: { how: join(other, "how/SKILL.md") } });
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:how", source: "interactive" });
    await f.emit("input", { text: "/skill:unknown", source: "interactive" });
    expect(f.active()).toEqual(["read", "bash"]);
    expect(f.branch).toEqual([]);
  });

  test("symlinked package path: Pi's path and the extension's path resolve to the same realpath", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "pkg-link-")), "skills");
    symlinkSync(realpathSync(REPO_SKILLS), link);
    const f = makePi({ skillsDir: link, skillCommands: { how: join(REPO_SKILLS, "how/SKILL.md") } });
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:how", source: "interactive" });
    expect(stateFromBranch(f.branch).active).toBe(true);
  });

  test("read of an own SKILL.md activates (via relative or symlinked path); other files do not", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    const read = (path: string, isError = false) =>
      f.emit("tool_result", { toolName: "read", input: { path }, content: [], isError });
    await read(join(REPO_SKILLS, "how/references/explorer-prompt.md"));
    await read(join(REPO_SKILLS, "../agents/poteto-agent.md"));
    await read(join(REPO_SKILLS, "how/SKILL.md"), true);
    expect(f.branch).toEqual([]);

    const link = join(mkdtempSync(join(tmpdir(), "read-link-")), "s");
    symlinkSync(realpathSync(REPO_SKILLS), link);
    f.ctx.cwd = link;
    await read("@how/SKILL.md");
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: false });
  });

  test("an own SKILL.md symlinked to a file outside the package does not count as own", async () => {
    const root = mkdtempSync(join(tmpdir(), "pkg-escape-"));
    const outside = join(root, "outside.md");
    writeFileSync(outside, "---\nname: how\ndescription: x\n---\nbody\n");
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "how"), { recursive: true });
    symlinkSync(outside, join(skillsDir, "how/SKILL.md"));
    const f = makePi({ skillsDir });
    await f.emit("session_start", { reason: "startup" });
    await f.emit("tool_result", { toolName: "read", input: { path: outside }, content: [], isError: false });
    await f.emit("tool_result", { toolName: "read", input: { path: join(skillsDir, "how/SKILL.md") }, content: [], isError: false });
    expect(f.branch).toEqual([]);
  });

  test("state follows the branch on session_tree / session_start", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:poteto-mode", source: "interactive" });
    expect(f.active()).toContain("Task");

    // Navigate to a branch without the entry.
    f.branch.length = 0;
    await f.emit("session_tree", { newLeafId: null, oldLeafId: null });
    expect(f.active()).toEqual(["read", "bash"]);
    expect(await f.turn()).toEqual({});

    // Resume/fork onto a branch whose last state entry is active.
    f.branch.push({ type: "custom", customType: STATE_ENTRY, data: { active: true, poteto: false } });
    await f.emit("session_start", { reason: "resume" });
    expect(f.active()).toEqual(["read", "bash", ...OWNED]);
    expect((await f.turn()).pstack_mode).toBeUndefined();
  });

  test("stateFromBranch: last entry wins, poteto requires active", () => {
    const e = (data: unknown) => ({ type: "custom", customType: STATE_ENTRY, data });
    expect(stateFromBranch([])).toEqual({ active: false, poteto: false });
    expect(stateFromBranch([e({ active: true, poteto: true }), e({ active: false, poteto: false })])).toEqual({
      active: false,
      poteto: false,
    });
    expect(stateFromBranch([e({ active: false, poteto: true })])).toEqual({ active: false, poteto: false });
    expect(stateFromBranch([{ type: "custom", customType: "other", data: { active: true } }])).toEqual({ active: false, poteto: false });
  });
});

// ---------- /pstack and collisions ----------

describe("/pstack and collisions", () => {
  test("/pstack off removes only owned tools and never restores a snapshot", async () => {
    const f = makePi({ otherTools: ["web_search"] });
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("pstack").handler("on", f.ctx);
    expect(f.active()).toEqual(["read", "bash", "web_search", ...OWNED]);
    // Another extension changes the active set while pstack is on.
    f.pi.setActiveTools([...f.active().filter((t) => t !== "bash"), "grep"]);
    await f.commands.get("pstack").handler("off", f.ctx);
    expect(f.active()).toEqual(["read", "web_search", "grep"]);
    expect(stateFromBranch(f.branch)).toEqual({ active: false, poteto: false });
  });

  test("/pstack status is read-only; /pstack on is not poteto", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("pstack").handler("status", f.ctx);
    expect(f.branch).toEqual([]);
    expect(f.notes.at(-1)?.message).toContain("pstack: inactive");
    await f.commands.get("pstack").handler("on", f.ctx);
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: false });
  });

  test("tool collision: the other extension's tool is kept, untouched by on/off, and reported", async () => {
    const f = makePi({ otherTools: ["Task"] });
    await f.emit("session_start", { reason: "startup" });
    expect(f.tools.has("Task")).toBe(false);
    expect(f.notes.some((n) => n.type === "warning" && n.message.includes('"Task"'))).toBe(true);
    await f.commands.get("pstack").handler("on", f.ctx);
    expect(f.active()).toEqual(["read", "bash", "Task", "TaskStatus", "TaskOutput", "TaskCancel", "AskQuestion", "pstack_config", "GoalSet", "GoalDone", "LoopStart", "LoopStop", "LoopSchedule"]);
    await f.commands.get("pstack").handler("off", f.ctx);
    expect(f.active()).toEqual(["read", "bash", "Task"]);
    await f.commands.get("pstack").handler("status", f.ctx);
    expect(f.notes.at(-1)?.message).toContain("tool collisions (not provided): Task");
  });

  test("repeated /pstack on re-applies the tool set even when state is unchanged", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("pstack").handler("on", f.ctx);
    const entries = f.branch.length;
    f.pi.setActiveTools(f.active().filter((n: string) => n !== "Task"));
    await f.commands.get("pstack").handler("on", f.ctx);
    expect(f.active()).toContain("Task");
    expect(f.branch.length).toBe(entries);
  });

  test("late tool takeover is not disabled by /pstack off and is reported", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("pstack").handler("on", f.ctx);
    f.lateTools.set("Task", {});
    await f.commands.get("pstack").handler("off", f.ctx);
    expect(f.active()).toContain("Task");
    await f.commands.get("pstack").handler("status", f.ctx);
    expect(f.notes.at(-1)?.message).toContain("tool collisions (not provided): Task");
    expect(f.notes.some((n) => n.type === "warning" && n.message.includes('"Task"'))).toBe(true);
  });

  test("command collision: existing /how is not overridden; status reports it", async () => {
    const f = makePi({ otherCommands: ["how"] });
    await f.emit("session_start", { reason: "startup" });
    expect(f.commands.has("how")).toBe(false);
    expect(f.commands.has("why")).toBe(true);
    await f.commands.get("pstack").handler("status", f.ctx);
    expect(f.notes.at(-1)?.message).toContain("command collisions (not registered): /how");
  });

  test("skill command activates and submits /skill:<name> <args> through Pi's expansion", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("how").handler("  where is X  ", f.ctx);
    expect(f.sent).toEqual([{ text: "/skill:how where is X", options: { expandPromptTemplates: true } }]);
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: false });
    await f.commands.get("poteto-mode").handler("", f.ctx);
    expect(f.sent.at(-1)?.text).toBe("/skill:poteto-mode");
    expect(stateFromBranch(f.branch)).toEqual({ active: true, poteto: true });
  });

  test("skill command refuses when Pi resolves the name to another package", async () => {
    const f = makePi({ skillCommands: { how: "/elsewhere/how/SKILL.md" } });
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("how").handler("", f.ctx);
    expect(f.sent).toEqual([]);
    expect(f.branch).toEqual([]);
  });
});

// ---------- R3 injection ----------

describe("per-turn injection (R3)", () => {
  function writeRule(name: string, text: string) {
    mkdirSync(join(home, "rules"), { recursive: true });
    writeFileSync(join(home, "rules", name), text);
  }

  test("order: adapter, rules, (poteto) mode, paths; ordinary skill has no poteto reminder/grant", async () => {
    writeRule("a.mdc", "---\nalwaysApply: true\n---\nRULE A BODY\n");
    writeRule("b.mdc", "---\nalwaysApply: false\n---\nNOT ME\n");
    writeRule("bad.mdc", "---\nalwaysApply: [\n---\nbroken\n");
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:how", source: "interactive" });
    await f.emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false });

    const sections = await f.turn();
    expect(Object.keys(sections)).toEqual(["pstack_adapter", "pstack_rules", "pstack_paths"]);
    const all = Object.values(sections).join("\n");
    expect(all).not.toContain(POTETO_GRANT);
    expect(all).not.toContain(POTETO_REMINDER);
    expect(sections.pstack_rules).toContain("RULE A BODY");
    expect(sections.pstack_rules).not.toContain("NOT ME");
    expect(f.notes.some((n) => n.message.includes("bad.mdc"))).toBe(true);
    expect(sections.pstack_paths).toContain("skill typescript-best-practices applies");

    const adapter = sections.pstack_adapter as string;
    expect(adapter).toContain("- anthropic/opus (thinking: off, minimal, low, medium, high, xhigh, max)");
    expect(adapter).toContain("- local/plain (thinking: off)");
    expect(adapter).toContain("configured credentials, not a liveness check");
    expect(adapter).toContain("/sessions/--work--/s.jsonl");
    expect(adapter).toContain(modelsRulePath(home));
    expect(adapter).toContain('environment: "cloud"');
    expect(adapter).toContain("Bugbot");
    expect(adapter).toContain(`Agent store (Cursor's per-workspace store; orchestrate/, docs/): ${join(home, "projects")}/--`);
    expect(adapter).toMatch(/bun \S+\/skills\/poteto-mode\/scripts\/orch\/orch\.ts --store/);
    expect(adapter).toContain("GoalSet/GoalDone");
    expect(adapter).toContain("MCP servers connected now: none.");
    expect(adapter).toContain("this package's `create-skill` skill");

    // Path hints fire once per session.
    await f.emit("tool_result", { toolName: "read", input: { path: "src/b.ts" }, content: [], isError: false });
    expect((await f.turn()).pstack_paths).toBeUndefined();
  });

  test("poteto mode adds reminder then grant after rules", async () => {
    writeRule("a.mdc", "---\nalwaysApply: true\n---\nRULE A\n");
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.emit("input", { text: "/skill:poteto-mode", source: "interactive" });
    const sections = await f.turn();
    expect(Object.keys(sections)).toEqual(["pstack_adapter", "pstack_rules", "pstack_mode"]);
    const mode = sections.pstack_mode as string;
    expect(mode.indexOf(POTETO_REMINDER)).toBe(0);
    expect(mode.indexOf(POTETO_GRANT)).toBeGreaterThan(0);
  });

  test("same-run requests reflect read activation and off without another before_agent_start", async () => {
    writeRule("a.mdc", "---\nalwaysApply: true\n---\nRULE A\n");
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    const initial = { role: "system", content: "", sections: { preamble: "base", other: "keep" }, timestamp: 0 };
    const request = async (messages: any[]) => {
      const event = await f.emit("context_with_system", { messages });
      return event?.messages ?? messages;
    };
    const untouched = await request([initial]);
    expect(getCurrentSystemMessage(untouched)?.sections).toEqual(initial.sections);
    await f.emit("tool_result", { toolName: "read", input: { path: join(REPO_SKILLS, "how/SKILL.md") }, isError: false });
    const activated = await request(untouched);
    expect(getCurrentSystemMessage(activated)?.sections?.pstack_adapter).toContain("pstack skills");
    expect(getCurrentSystemMessage(activated)?.sections?.pstack_rules).toContain("RULE A");
    expect(getCurrentSystemMessage(activated)?.sections?.other).toBe("keep");
    await f.emit("input", { text: "/skill:poteto-mode" });
    const poteto = await request(activated);
    expect(getCurrentSystemMessage(poteto)?.sections?.pstack_mode).toContain(POTETO_GRANT);
    await f.commands.get("pstack").handler("off", f.ctx);
    const disabled = await request(poteto);
    expect(getCurrentSystemMessage(disabled)?.sections).toEqual(initial.sections);
  });

  test("inactive: nothing injected, no path hints recorded", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    await f.emit("tool_result", { toolName: "edit", input: { path: "a.ts" }, content: [], isError: false });
    expect(await f.turn()).toEqual({});
    await f.commands.get("pstack").handler("on", f.ctx);
    await f.emit("tool_result", { toolName: "edit", input: { path: "a.ts" }, content: [], isError: false });
    expect((await f.turn()).pstack_paths).toContain("typescript-best-practices");
  });
});

// ---------- R6 AskQuestion ----------

describe("AskQuestion (R6)", () => {
  const options = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ];
  function scriptedUi(answers: (string | undefined | ((opts: string[]) => string | undefined))[]) {
    const calls: { title: string; options: string[] }[] = [];
    return {
      calls,
      ctx: {
        hasUI: true,
        ui: {
          select: async (title: string, opts: string[]) => {
            calls.push({ title, options: opts });
            const next = answers.shift();
            return typeof next === "function" ? next(opts) : next;
          },
        },
      } as any,
    };
  }

  test("single choice", async () => {
    const ui = scriptedUi(["2. Beta"]);
    const result = await askQuestions({ title: "T", questions: [{ id: "q", prompt: "Pick", options }] }, ui.ctx);
    expect(result).toEqual({ cancelled: false, answers: [{ id: "q", selected: [{ id: "b", label: "Beta" }] }] });
    expect(ui.calls[0]?.title).toBe("T\nPick");
  });

  test("multi choice toggles then Done", async () => {
    const pick = (label: string) => (opts: string[]) => opts.find((o) => o.endsWith(label));
    const ui = scriptedUi([pick("Gamma"), pick("Alpha"), pick("Gamma"), pick("Beta"), "Done", "1. Alpha"]);
    const result = await askQuestions(
      { questions: [{ id: "m", prompt: "Pick many", options, allow_multiple: true }, { id: "s", prompt: "One", options }] },
      ui.ctx,
    );
    expect(ui.calls[4]?.options).toEqual(["[x] 1. Alpha", "[x] 2. Beta", "[ ] 3. Gamma", "Done"]);
    expect(result).toEqual({
      cancelled: false,
      answers: [
        { id: "m", selected: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
        { id: "s", selected: [{ id: "a", label: "Alpha" }] },
      ],
    });
  });

  test("cancel returns an explicit cancelled result with earlier answers", async () => {
    const ui = scriptedUi(["1. Alpha", undefined]);
    const result = await askQuestions(
      { questions: [{ id: "q1", prompt: "P", options }, { id: "q2", prompt: "P", options }] },
      ui.ctx,
    );
    expect(result).toEqual({ cancelled: true, answers: [{ id: "q1", selected: [{ id: "a", label: "Alpha" }] }] });
  });

  test("no UI: explicit error telling the model to ask in plain text", async () => {
    await expect(askQuestions({ questions: [{ id: "q", prompt: "P", options }] }, { hasUI: false } as any)).rejects.toThrow(
      /plain text/,
    );
  });

  test("tool wrapper reports cancellation in content", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    const ctx = { ...f.ctx, ui: { select: async () => undefined } };
    const res = await f.tools.get("AskQuestion").execute("id", { questions: [{ id: "q", prompt: "P", options }] }, undefined, undefined, ctx);
    expect(res.content[0].text).toContain("cancelled");
    expect(res.details.cancelled).toBe(true);
  });
});

// ---------- R5 pstack_config, R7 Task ----------

function fullRoles(value: string): Record<string, string | string[]> {
  return Object.fromEntries(ROLES.map((r) => [r.name, r.panel ? [value, "auto"] : value]));
}

describe("pstack_config (R5) and Task (R7)", () => {
  const ctx = { modelRegistry: fakeRegistry() } as any;

  test("read with no config reports missing", () => {
    const res = runConfigTool({ action: "read" }, ctx);
    expect(res.text).toContain('"exists": false');
    expect(res.text).toContain("Validation: invalid");
  });

  test("write → read round-trip under PSTACK_HOME; file is upstream-shaped", () => {
    const roles = fullRoles("anthropic/opus:high");
    roles["bug-fix"] = "local/plain";
    const res = runConfigTool({ action: "write", roles, budget: "medium" }, ctx);
    expect(res.text).toContain(`Wrote ${modelsRulePath(home)}`);
    expect(res.text).toContain("Validation: ok");
    const file = readFileSync(modelsRulePath(home), "utf8");
    expect(file).toContain("alwaysApply: true");
    expect(file).toContain("# budget: medium (high)");
    expect(file).toContain("arena runners: anthropic/opus:high, auto");
    const read = runConfigTool({ action: "read" }, ctx);
    expect((read.details as any).roles).toEqual(roles);
    expect((read.details as any).budget).toEqual({ name: "medium", level: "high" });
    expect(read.text).toContain("Validation: ok");
  });

  test("write maps the chosen budget before serializing, including panel entries", () => {
    const roles = fullRoles("anthropic/opus:max");
    roles["bug-fix"] = "local/plain";
    const res = runConfigTool({ action: "write", roles, budget: "small" }, ctx);
    expect(res.text).toContain("Validation: ok");
    const file = readFileSync(modelsRulePath(home), "utf8");
    expect(file).toContain("bug-fix: local/plain\n");
    expect(file).toContain("feature, refactoring: anthropic/opus:medium\n");
    expect(file).toContain("arena runners: anthropic/opus:medium, auto\n");
    expect((runConfigTool({ action: "read" }, ctx).details as any).roles["bug-fix"]).toBe("local/plain");
  });

  test("write refuses unmappable budget entries and preserves the prior file", () => {
    runConfigTool({ action: "write", roles: fullRoles("auto"), budget: "small" }, ctx);
    const before = readFileSync(modelsRulePath(home), "utf8");
    expect(() => runConfigTool({ action: "write", roles: fullRoles("gone/model"), budget: "small" }, ctx)).toThrow(/needs a choice.*feature, refactoring/s);
    expect(readFileSync(modelsRulePath(home), "utf8")).toBe(before);
  });

  test("invalid write is rejected and leaves the existing file untouched", () => {
    runConfigTool({ action: "write", roles: fullRoles("auto"), budget: "small" }, ctx);
    const before = readFileSync(modelsRulePath(home), "utf8");
    const bad = fullRoles("auto");
    bad["bug-fix"] = "claude-opus-5-5-max";
    delete bad["swarm workers"];
    expect(() => runConfigTool({ action: "write", roles: bad, budget: "small" }, ctx)).toThrow(/missing role "swarm workers"/);
    expect(() => runConfigTool({ action: "write", roles: fullRoles("auto"), budget: "huge" }, ctx)).toThrow(/budget/);
    expect(readFileSync(modelsRulePath(home), "utf8")).toBe(before);
  });

  test("Task gate and rule loader agree on malformed, duplicate and commented YAML", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    runConfigTool({ action: "write", roles: fullRoles("auto"), budget: "small" }, ctx);
    const path = modelsRulePath(home);
    const good = readFileSync(path, "utf8");
    const task = () => f.tools.get("Task").execute("id", { description: "d", prompt: "p" }, undefined, undefined, f.ctx);
    for (const text of [good.replace("alwaysApply: true", "alwaysApply: ["), good.replace("alwaysApply: true", "alwaysApply: true\nalwaysApply: false")]) {
      writeFileSync(path, text);
      expect(loadAlwaysApplyRules(join(home, "rules")).rules).toEqual([]);
      await expect(task()).rejects.toThrow(/pstack is not configured/);
    }
    writeFileSync(path, good.replace("alwaysApply: true", "alwaysApply: true # enabled"));
    expect(loadAlwaysApplyRules(join(home, "rules")).rules).toHaveLength(1);
    process.env.PSTACK_PI_BIN = FAKE_PI;
    const ok = await f.tools.get("Task").execute("id", { description: "d", prompt: "echo:hi" }, undefined, undefined, f.ctx);
    expect(ok.content[0].text).toBe("hi");
  });

  test("Task: not configured → setup error; unknown model → available ids; valid → runs with the resolved model", async () => {
    const f = makePi();
    await f.emit("session_start", { reason: "startup" });
    const task = (model?: string) =>
      f.tools.get("Task").execute("id", { description: "d", prompt: "p", ...(model ? { model } : {}) }, undefined, undefined, f.ctx);
    await expect(task()).rejects.toThrow(/pstack is not configured: run \/setup-pstack[\s\S]*config file does not exist/);
    runConfigTool({ action: "write", roles: fullRoles("auto"), budget: "small" }, ctx);
    await expect(task("nope/x")).rejects.toThrow(/Unknown model "nope\/x"[\s\S]*anthropic\/opus, local\/plain/);
    await expect(task("local/plain:high")).rejects.toThrow(/Supported levels: off/);
    process.env.PSTACK_PI_BIN = FAKE_PI;
    const run = (model: string) =>
      f.tools.get("Task").execute("id", { description: "d", prompt: "args", model }, undefined, undefined, f.ctx);
    const explicit = JSON.parse((await run("anthropic/opus:max")).content[0].text);
    expect(explicit.args.slice(explicit.args.indexOf("--model"), explicit.args.indexOf("--model") + 4)).toEqual(["--model", "anthropic/opus", "--thinking", "max"]);
    const parent = JSON.parse((await run("inherit-parent")).content[0].text);
    expect(parent.args.slice(parent.args.indexOf("--model"), parent.args.indexOf("--model") + 4)).toEqual(["--model", "anthropic/opus", "--thinking", "high"]);
  });
});

describe("create-skill (extras)", () => {
  test("the package's create-skill is an own skill: command, activation on read, child --skill", () => {
    const EXTRAS = fileURLToPath(new URL("../extras/skills", import.meta.url));
    const f = makePi({ extraSkillsDir: EXTRAS, skillCommands: { "create-skill": join(EXTRAS, "create-skill/SKILL.md") } });
    return (async () => {
      await f.emit("session_start", { reason: "startup" });
      expect(f.commands.has("create-skill")).toBe(true);
      await f.emit("tool_result", { toolName: "read", input: { path: join(EXTRAS, "create-skill/SKILL.md") }, content: [], isError: false });
      expect(f.branch.filter((e: any) => e.customType === "pstack-state").at(-1)?.data).toEqual({ active: true, poteto: false });
    })();
  });
});

describe("MCP inventory (Cursor mcps/ map)", () => {
  test("adapter lists connected MCP servers and their tools", async () => {
    const f = makePi({ otherTools: ["mcp__docs__search", "mcp__docs__fetch", "mcp__jira__get_issue", "web_search"] });
    await f.emit("session_start", { reason: "startup" });
    await f.commands.get("pstack").handler("on", f.ctx);
    const adapter = (await f.turn()).pstack_adapter as string;
    expect(adapter).toContain("  - docs: 2 tool(s) (search, fetch)");
    expect(adapter).toContain("  - jira: 1 tool(s) (get_issue)");
    expect(adapter).not.toContain("web_search");
  });
});
