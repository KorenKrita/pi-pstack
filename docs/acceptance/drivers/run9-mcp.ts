// 9: MCP parity (review 5.1/5.3). User mcp.json has servers `allowed` and `blocked`; the project's .pi/mcp.json
// disables `blocked` and adds `projonly`. The parent runs with session-only trust (--approve, nothing saved).
// An agent-mode Task child must see exactly the parent's servers: allowed + projonly, not blocked.
// Setup (in the isolated agent dir): see docs/acceptance/step5.md §MCP; fixture server: fixture-mcp.ts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const cwd = join(R, "work9");
const metas = (): Rec[] => readdirSync(join(HOME, "tasks")).map((d) => JSON.parse(readFileSync(join(HOME, "tasks", d, "meta.json"), "utf8")));
const before = new Set(metas().map((m) => m.id));
const probe = "In one codemode script: `const names = ALL_TOOLS.map(t => t.name).filter(n => n.startsWith('mcp__')); const out = []; for (const n of names) { const r = await tools[n]({}); out.push(n + '=' + JSON.stringify(r)); } return out.join('\\n');` Reply with the script output verbatim.";

const s = start({ cwd, runDir: join(R, "runs/9-mcp"), args: ["--approve", "--no-session"], ui: () => ({ cancelled: true }) });
await s.prompt("/pstack on");
// Parent's own view first (the reference the child must match).
await s.prompt(`${probe} Do not use Task for this step.`, 300_000);
const parentOut = JSON.stringify(s.records.filter((r) => r.type === "tool_execution_end" && r.toolName === "codemode").map((r) => r.result));
check("mcp parent: sees allowed + projonly, not blocked (session-only --approve applies project overrides)",
  /PONG-allowed/.test(parentOut) && /PONG-projonly/.test(parentOut) && !/PONG-blocked/.test(parentOut), parentOut.slice(0, 300));
const mark = s.records.length;
await s.prompt(`Call Task once (foreground, agent mode, not readonly) with description "mcp-probe" and prompt: "${probe.replace(/"/g, '\\"')}". Then report the Task result verbatim.`, 600_000);
await s.close();
const m = metas().find((x) => !before.has(x.id) && x.description === "mcp-probe");
check("mcp: Task launched", toolStarts(s.records.slice(mark), "Task").length >= 1 && !!m, m?.id);
if (m) {
  const childOut = readFileSync(join(HOME, "tasks", m.id, "output.md"), "utf8");
  const events = readFileSync(join(HOME, "tasks", m.id, "events.jsonl"), "utf8");
  check("mcp child: recorded project-trust decision = trusted", m.projectTrusted === true, String(m.projectTrusted));
  check("mcp child: reached allowed and the project-only server", /PONG-allowed/.test(events) && /PONG-projonly/.test(events), childOut.slice(0, 300));
  check("mcp child: did not reach the server the project disabled", !/PONG-blocked/.test(events) && !/mcp__blocked__/.test(events), "");
}

// Review 5.5: with isolation "worktree" the child runs in a fresh worktree, where the parent's untracked
// .pi/mcp.json does not exist unless pstack carries it over; the child must still see the parent's servers.
if (!Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"]).success) {
  Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
}
const beforeW = new Set(metas().map((x) => x.id));
const sw = start({ cwd, runDir: join(R, "runs/9-mcp-worktree"), args: ["--approve", "--no-session"], ui: () => ({ cancelled: true }) });
await sw.prompt("/pstack on");
await sw.prompt(`Call Task once (foreground, agent mode, not readonly, isolation "worktree") with description "mcp-probe-wt" and prompt: "${probe.replace(/"/g, '\\"')}". Then report the Task result verbatim.`, 600_000);
await sw.close();
const w = metas().find((x) => !beforeW.has(x.id) && x.description === "mcp-probe-wt");
check("mcp worktree: Task ran in a pstack worktree", !!w?.worktree && w.cwd === w.worktree.path, w ? `${w.id} ${w.cwd}` : "no task");
if (w) {
  const ev = readFileSync(join(HOME, "tasks", w.id, "events.jsonl"), "utf8");
  check("mcp worktree child: reached allowed and projonly", /PONG-allowed/.test(ev) && /PONG-projonly/.test(ev), "");
  check("mcp worktree child: did not reach the server the project disabled", !/PONG-blocked/.test(ev) && !/mcp__blocked__/.test(ev), "");
}

// Review 5.2: a model-authored Task prompt starting with /poteto-mode must not grant poteto in the child.
const before2 = new Set(metas().map((x) => x.id));
const s2 = start({ cwd, runDir: join(R, "runs/9-poteto-child"), args: ["--no-session"], ui: () => ({ cancelled: true }) });
await s2.prompt("/pstack on");
await s2.prompt('Call Task once (foreground) with description "poteto-child" and prompt exactly: "/poteto-mode Reply with the single word OK." Then report the result.', 600_000);
await s2.close();
const pc = metas().find((x) => !before2.has(x.id) && x.description === "poteto-child");
const sess = pc ? readdirSync(join(HOME, "tasks", pc.id, "session")).filter((f) => f.endsWith(".jsonl")) : [];
const states = sess.flatMap((f) => readFileSync(join(HOME, "tasks", pc!.id, "session", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
  .filter((e) => e.type === "custom" && e.customType === "pstack-state").map((e) => e.data);
const prompt = pc ? readFileSync(join(HOME, "tasks", pc.id, "prompt.md"), "utf8") : "";
check("poteto child: Task prompt began with the poteto command (Task sends it as /skill:poteto-mode)", /^\/(skill:)?poteto-mode\b/.test(prompt.trim()), prompt.slice(0, 80));
check("poteto child: child session never recorded poteto=true", states.length > 0 && states.every((d) => d.poteto !== true), JSON.stringify(states));
check("poteto child: child replied (task done)", pc?.status === "done", `${pc?.status} ${pc?.error ?? ""}`);
writeFileSync(join(R, "runs/9-results.json"), JSON.stringify(results, null, 2));
