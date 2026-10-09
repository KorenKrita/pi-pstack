// 5: background Task → completion notification wakes the idle parent; resume same task id; cancel → no wake; /pstack off → no wake.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const cwd = join(R, "work5");
mkdirSync(cwd, { recursive: true });
const meta = (id: string) => JSON.parse(readFileSync(join(HOME, "tasks", id, "meta.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const taskIdFrom = (records: Rec[], from = 0) => {
  for (const r of records.slice(from)) if (r.type === "tool_execution_end" && r.toolName === "Task") {
    const m = JSON.stringify(r.result).match(/\bt[a-z0-9]{12}\b/); if (m) return m[0];
  }
  return undefined;
};
const notifications = (records: Rec[], id: string) => records.filter((r) => r.type === "message_start" && r.message?.role === "custom" && r.message?.customType === "pstack-task-done" && r.message?.details?.taskId === id);

const s = start({ cwd, runDir: join(R, "runs/5-bg"), args: ["--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
await s.prompt("/pstack on");

// --- A: background wake ---
let mark = s.records.length;
await s.prompt('Call the Task tool once with run_in_background: true, description "bg-wake", and prompt: "Run `sleep 25` with bash, then reply with exactly: BG-DONE-1". Do not wait for it or poll it; after launching, reply "launched" and stop.');
const settledAt = Date.now();
const idA = taskIdFrom(s.records, mark);
check("bg: Task launched in background and returned an id", !!idA, idA);
const mA = idA ? meta(idA) : undefined;
check("bg: parent turn settled while task still running", !!mA && (mA.status === "running" || mA.status === "queued"), mA?.status);
// wait for the wake: a new agent_start after completion, driven by the notification
let woke: Rec | undefined;
try { woke = await s.waitFor((r) => r.type === "agent_start" && r._t > settledAt, 240_000, "wake agent_start"); } catch (e) { console.log(String(e)); }
check("bg: completion woke the idle parent (new agent_start, no user prompt)", !!woke && !s.records.some((r) => r._sent?.type === "prompt" && r._t > settledAt && r._t < woke!._t));
await s.waitFor((r) => r.type === "agent_settled" && r._t > (woke?._t ?? 0), 300_000, "wake settle").catch(() => {});
await sleep(3000);
const nA = idA ? notifications(s.records, idA) : [];
check("bg: exactly one completion notification for the run", nA.length === 1, `n=${nA.length}`);
check("bg: notification carries the child result", nA.some((n) => /BG-DONE-1/.test(JSON.stringify(n.message.content))) || (idA ? /BG-DONE-1/.test(readFileSync(join(HOME, "tasks", idA, "output.md"), "utf8").toString()) : false));
const doneAt = idA ? Date.parse(meta(idA).endedAt) : 0;
check("bg: event order settle < task end < wake", settledAt < doneAt + 1000 && doneAt <= (woke?._t ?? 0), `settle=${settledAt} end=${doneAt} wake=${woke?._t}`);

// --- B: resume same id ---
mark = s.records.length;
const sessBefore = idA ? readdirSync(join(HOME, "tasks", idA, "session")) : [];
await s.prompt(`Call the Task tool once (foreground) with resume: "${idA}", description "bg-wake resume", prompt: "What exact text did you reply with last time? Reply with that text followed by -AGAIN". Then report the result verbatim.`);
const resumeCall = toolStarts(s.records.slice(mark), "Task")[0];
const mB = idA ? meta(idA) : undefined;
const sessAfter = idA ? readdirSync(join(HOME, "tasks", idA, "session")) : [];
const resumeOut = JSON.stringify(s.records.slice(mark).filter((r) => r.type === "tool_execution_end" && r.toolName === "Task").map((r) => r.result));
check("resume: Task called with resume id", resumeCall?.args?.resume === idA, JSON.stringify(resumeCall?.args ?? {}).slice(0, 160));
check("resume: same task record, runs=2, done", mB?.runs === 2 && mB?.status === "done", `runs=${mB?.runs} status=${mB?.status}`);
check("resume: child session file reused (continued, not new)", sessBefore.length === 1 && sessAfter.length === 1 && sessBefore[0] === sessAfter[0], `${sessBefore} -> ${sessAfter}`);
check("resume: child remembered prior context", /BG-DONE-1-AGAIN/.test(resumeOut), resumeOut.slice(0, 200));
await sleep(3000);
check("resume: foreground resume did not produce a duplicate wake for run 1", idA ? notifications(s.records, idA).length === 1 : false);

// --- C: cancel → no wake ---
mark = s.records.length;
await s.prompt('Call Task once with run_in_background: true, description "bg-cancel", prompt "Run `sleep 60` with bash, then reply CANCEL-NOT-EXPECTED". Then immediately call TaskCancel on the returned task id. Reply "cancelled" and stop.');
const idC = taskIdFrom(s.records, mark);
const cancelStart = s.records.slice(mark).find((r) => r.type === "tool_execution_start" && r.toolName === "TaskCancel");
// Window starts at the cancel itself (record index, so same-millisecond events count); the parent turn's own
// agent_start came before it.
const cancelIdx = cancelStart ? s.records.indexOf(cancelStart) : -1;
await sleep(75_000);
const mC = idC ? meta(idC) : undefined;
check("cancel: TaskCancel called, record cancelled", cancelIdx >= 0 && mC?.status === "cancelled", `${idC} ${mC?.status}`);
check("cancel: child process gone", !!mC && (!mC.pid || Bun.spawnSync(["kill", "-0", String(mC.pid)]).exitCode !== 0), `pid=${mC?.pid}`);
check("cancel: no agent_start from the TaskCancel call on", cancelIdx >= 0 && !s.records.slice(cancelIdx).some((r) => r.type === "agent_start"), cancelIdx >= 0 ? "" : "no TaskCancel record");
check("cancel: zero completion notifications for the cancelled task (events)", !!idC && notifications(s.records, idC).length === 0, `n=${idC ? notifications(s.records, idC).length : "no task id"}`);

// --- D: /pstack off with a running bg task → no wake ---
mark = s.records.length;
await s.prompt('Call Task once with run_in_background: true, description "bg-off", prompt "Run `sleep 20` with bash, then reply OFF-DONE". Reply "launched" and stop.');
const idD = taskIdFrom(s.records, mark);
const offMark = s.records.length;
await s.prompt("/pstack off");
const offIdx = s.records.findIndex((r, i) => i >= offMark && r._sent?.type === "prompt"); // the off command itself
await sleep(60_000);
const mD = idD ? meta(idD) : undefined;
check("off: bg task still recorded (finished or cancelled)", !!mD && mD.status !== "running", `${idD} ${mD?.status}`);
check("off: no agent_start from /pstack off on", offIdx >= 0 && !s.records.slice(offIdx).some((r) => r.type === "agent_start"), offIdx >= 0 ? "" : "no off record");
check("off: zero completion notifications for the task (events)", !!idD && notifications(s.records, idD).length === 0, `n=${idD ? notifications(s.records, idD).length : "no task id"}`);
const entries = (await s.request({ type: "get_entries" })).data.entries as Rec[];
writeFileSync(join(R, "runs/5-bg/entries.json"), JSON.stringify(entries, null, 2));
// Persisted side: completion notifications are custom_message entries, customType pstack-task-done, details.taskId.
const persisted = (id: string) => entries.filter((e) => e.type === "custom_message" && e.customType === "pstack-task-done" && e.details?.taskId === id);
check("bg: exactly one persisted completion notification for the woken task", !!idA && persisted(idA).length === 1, idA ? `n=${persisted(idA).length}` : "no task id");
check("cancel/off: zero persisted completion notifications", !!idC && !!idD && persisted(idC).length === 0 && persisted(idD).length === 0, idC && idD ? `cancel=${persisted(idC).length} off=${persisted(idD).length}` : "missing task id");
await s.close();
writeFileSync(join(R, "runs/5-results.json"), JSON.stringify(results, null, 2));
