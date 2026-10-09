// 6: /loop ticks + stop; /goal to GoalDone + pause/resume; RPC abort mid-Task kills child; restart restores loop/goal from entries; bad model config.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const cwd = join(R, "work6");
const sessDir = join(R, "sessions6");
mkdirSync(cwd, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ticks = (records: Rec[], after = 0) => records.filter((r) => r.type === "message_start" && r.message?.role === "custom" && r.message?.customType === "pstack-loop-tick" && r._t > after);
const ui = () => ({ cancelled: true });

// ---- loop ----
let s = start({ cwd, runDir: join(R, "runs/6-loop"), args: ["--session-dir", sessDir], ui });
await s.prompt("/loop 30s Append one line with the current time to ticks.txt using bash (date >> ticks.txt), then reply ok.");
const t0 = Date.now();
await sleep(100_000);
const tk = ticks(s.records, t0);
const lines = existsSync(join(cwd, "ticks.txt")) ? readFileSync(join(cwd, "ticks.txt"), "utf8").trim().split("\n").length : 0;
check("loop: >=2 ticks within 100s at 30s interval", tk.length >= 2, `ticks=${tk.length} lines=${lines}`);
check("loop: each tick ran the prompt (ticks.txt lines >= ticks)", lines >= 2, `lines=${lines}`);
const loopEntries = ((await s.request({ type: "get_entries" })).data.entries as Rec[]).filter((e) => e.customType === "pstack-loop");
check("loop: start recorded in session entries (op add)", loopEntries.some((e) => e.data?.op === "add"), loopEntries.map((e) => e.data?.op).join(","));

// restart: close the process with the loop active; a new process on the same session restores it
const sessionFile = (await s.request({ type: "get_state" })).data.sessionFile as string;
const busy = (await s.request({ type: "get_state" })).data.isStreaming;
if (busy) await s.waitFor((r) => r.type === "agent_settled", 120_000).catch(() => {});
await s.close();
const closedAt = Date.now();
s = start({ cwd, runDir: join(R, "runs/6-loop-restart"), args: ["--session-dir", sessDir, "--session", sessionFile], ui });
await sleep(70_000);
const tkR = ticks(s.records, closedAt);
check("restart: loop restored from session entries after process restart", tkR.length >= 1, `ticks after restart=${tkR.length}`);
await s.waitFor((r) => r.type === "agent_settled", 120_000).catch(() => {});
await s.prompt("/loop stop");
const stopAt = Date.now();
await sleep(70_000);
check("loop: no tick after /loop stop", ticks(s.records, stopAt + 500).length === 0, `ticks after stop=${ticks(s.records, stopAt + 500).length}`);
await s.close();

// ---- goal ----
s = start({ cwd, runDir: join(R, "runs/6-goal"), args: ["--session-dir", sessDir], ui });
await s.prompt("/goal Create files step1.txt, step2.txt and step3.txt in this directory, each containing its own name. Do exactly one file per turn, then end the turn; when all three exist, call GoalDone.", 900_000);
const goalEntries = ((await s.request({ type: "get_entries" })).data.entries as Rec[]).filter((e) => e.customType === "pstack-goal");
// Pi persists boundary messages and forwards them over RPC as entry_appended (display:false is not "not streamed").
const continues = s.records.filter((r) => r.type === "entry_appended" && r.entry?.customType === "pstack-goal-continue").length;
check("goal: all three files created", ["step1", "step2", "step3"].every((f) => existsSync(join(cwd, f + ".txt"))));
check("goal: GoalDone called and goal status done", toolStarts(s.records, "GoalDone").length >= 1 && goalEntries.at(-1)?.data?.status === "done", goalEntries.map((e) => e.data?.status).join(","));
check("goal: continued across turns without user input (goal-continue messages)", continues >= 1, `continues=${continues}`);
// pause on abort, resume on /goal resume
// Send without awaiting a short prompt wait, then look for the bash start from this mark on (no missed event).
const goalMark = s.records.length;
s.send({ type: "prompt", message: "/goal Run `sleep 40` with bash, then create final.txt, then call GoalDone." });
await s.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash", 120_000, "goal bash start", goalMark);
await s.request({ type: "abort" }, 60_000);
await sleep(2000);
let g = ((await s.request({ type: "get_entries" })).data.entries as Rec[]).filter((e) => e.customType === "pstack-goal").at(-1)?.data;
check("goal: RPC abort (sent while bash ran) pauses the goal before the step finished", g?.status === "paused" && !existsSync(join(cwd, "final.txt")), `${JSON.stringify(g)} abort after bash start; sleep 40 not done`);
const abortAt = Date.now();
await sleep(5000);
check("goal: no continuation after abort", !s.records.some((r) => r.type === "agent_start" && r._t > abortAt));
await s.prompt("/goal resume", 600_000);
await s.waitFor((r) => r.type === "agent_settled" && r._t > abortAt + 5000, 600_000).catch(() => {});
g = ((await s.request({ type: "get_entries" })).data.entries as Rec[]).filter((e) => e.customType === "pstack-goal").at(-1)?.data;
check("goal: /goal resume continues to GoalDone", existsSync(join(cwd, "final.txt")) && g?.status === "done", JSON.stringify(g)?.slice(0, 160));
await s.close();

// ---- RPC abort mid foreground Task kills the child ----
s = start({ cwd, runDir: join(R, "runs/6-abort"), args: ["--session-dir", sessDir], ui });
await s.prompt("/pstack on");
const p = s.prompt('Call Task once (foreground) with description "abort-me", prompt "Run `sleep 120` with bash, then reply LATE". Report the result.', 300_000).catch(() => {});
await s.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "Task", 120_000);
await sleep(15_000);
const tasks = readdirSync(join(HOME, "tasks")).map((d) => JSON.parse(readFileSync(join(HOME, "tasks", d, "meta.json"), "utf8"))).filter((m) => m.description === "abort-me");
const victim = tasks.at(-1);
// The child's whole process tree before the abort (child pi → bash → sleep), so the check is scoped to its descendants.
const tree = (root: number): number[] => {
  const kids = Bun.spawnSync(["pgrep", "-P", String(root)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  return [root, ...kids.flatMap(tree)];
};
const treeBefore = victim?.pid ? tree(victim.pid) : [];
const sleepInTree = treeBefore.some((pid) => /\bsleep 120\b/.test(Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString()));
await s.request({ type: "abort" }, 60_000);
await p;
await sleep(3000);
const after = JSON.parse(readFileSync(join(HOME, "tasks", victim.id, "meta.json"), "utf8"));
check("abort: foreground Task record cancelled/error after RPC abort", after.status === "cancelled" || after.status === "error", `${victim.id} ${after.status}`);
check("abort: child pi process killed", !after.pid || Bun.spawnSync(["kill", "-0", String(after.pid)]).exitCode !== 0, `pid=${after.pid}`);
const alive = treeBefore.filter((pid) => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0);
check("abort: the Task child's descendants (incl. its `sleep 120`) are gone", treeBefore.length > 1 && sleepInTree && alive.length === 0, `tree=${treeBefore.join(",")} sleepInTree=${sleepInTree} alive=${alive.join(",")}`);
await s.close();

// ---- bad model in config ----
const mdc = join(HOME, "rules", "pstack-models.mdc");
copyFileSync(mdc, mdc + ".good");
writeFileSync(mdc, readFileSync(mdc, "utf8").replace(/^swarm workers: .*$/m, "swarm workers: local-openai/no-such-model:high"));
s = start({ cwd, runDir: join(R, "runs/6-badcfg"), args: ["--no-session"], ui });
await s.prompt("/pstack on");
const before = readdirSync(join(HOME, "tasks")).length;
await s.prompt('Call Task once with description "bad" and prompt "say hi". Report the tool result verbatim.');
const ends = s.records.filter((r) => r.type === "tool_execution_end" && r.toolName === "Task");
const txt = JSON.stringify(ends.map((e) => e.result));
check("badcfg: Task rejected while config names an unknown model", ends.length >= 1 && ends.every((e) => e.isError), txt.slice(0, 240));
check("badcfg: error names the role and model", /swarm workers/.test(txt) && /no-such-model/.test(txt));
check("badcfg: no child task created", readdirSync(join(HOME, "tasks")).length === before);
await s.close();
copyFileSync(mdc + ".good", mdc);
writeFileSync(join(R, "runs/6-results.json"), JSON.stringify(results, null, 2));
