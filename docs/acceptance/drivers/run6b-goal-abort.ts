// 6b: re-run of goal pause-on-abort / resume, with the abort sent while the goal's bash is in flight; goal-continue counted from the session file; orphan check scoped to this run's children.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const cwd = join(R, "work6b");
mkdirSync(cwd, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s = start({ cwd, runDir: join(R, "runs/6b-goal-abort"), args: ["--session-dir", join(R, "sessions6b")], ui: () => ({ cancelled: true }) });
const goalOf = async () => ((await s.request({ type: "get_entries" })).data.entries as Rec[]).filter((e) => e.customType === "pstack-goal").at(-1)?.data;

const MARK = `ACC6B_${process.pid}`;
s.send({ type: "prompt", message: `/goal Run \`sleep 90; echo ${MARK}\` with bash, then create final.txt, then call GoalDone.` });
const bashStart = await s.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash", 180_000, "goal bash");
check("goal-abort: goal's bash in flight before abort", /sleep 90/.test(String(bashStart.args?.command)), String(bashStart.args?.command).slice(0, 80));
await sleep(3000);
await s.request({ type: "abort" }, 60_000);
await sleep(2000);
let g = await goalOf();
check("goal-abort: RPC abort pauses the goal", g?.status === "paused", JSON.stringify(g)?.slice(0, 200));
const abortAt = Date.now();
await sleep(8000);
check("goal-abort: no continuation after abort", !s.records.some((r) => r.type === "agent_start" && r._t > abortAt));
const leftover = Bun.spawnSync(["pgrep", "-f", MARK]).stdout.toString().trim();
check("goal-abort: the aborted bash command is not left running", leftover === "", leftover);
check("goal-abort: final.txt not created while paused", !existsSync(join(cwd, "final.txt")));
const resumedAt = Date.now();
await s.request({ type: "prompt", message: "/goal resume" });
await s.waitFor((r) => r.type === "agent_settled" && r._t > resumedAt, 600_000, "resume settle").catch((e) => console.log(String(e)));
g = await goalOf();
check("goal-abort: /goal resume continues to GoalDone", existsSync(join(cwd, "final.txt")) && g?.status === "done", JSON.stringify(g)?.slice(0, 160));
const sessionFile = (await s.request({ type: "get_state" })).data.sessionFile as string;
await s.close();
writeFileSync(join(R, "runs/6b-results.json"), JSON.stringify(results, null, 2));

// Re-derive the item-6 goal-continue count from the session file of the 6-goal run (RPC does not stream display:false custom messages).
const { readdirSync } = await import("node:fs");
const counts = readdirSync(join(R, "sessions6")).filter((f) => f.endsWith(".jsonl")).map((f) => {
  const lines = readFileSync(join(R, "sessions6", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { f, continues: lines.filter((e) => e.customType === "pstack-goal-continue").length, goal: lines.filter((e) => e.customType === "pstack-goal").map((e) => e.data?.status) };
});
console.log(JSON.stringify(counts));
console.log("session", sessionFile);
