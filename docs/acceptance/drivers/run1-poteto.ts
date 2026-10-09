// 1: /poteto-mode small bug on a fixture repo. Assertions from git history + test runs + session entries.
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const cwd = join(R, "work1");
cpSync(join(R, "fixture-src"), cwd, { recursive: true });
const sh = (cmd: string) => {
  const p = Bun.spawnSync(["bash", "-lc", cmd], { cwd, env: process.env });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};
const base = sh("git rev-parse HEAD").out.trim();

const s = start({ cwd, runDir: join(R, "runs/1-poteto"), args: ["--session-dir", join(R, "sessions")], ui: (q) => (q.method === "confirm" ? { confirmed: true } : { cancelled: true }) });
try {
  await s.prompt("/poteto-mode Bug: mean([1, 2, 3]) returns 1 instead of 2 (src/stats.ts). Fix it. This is a local fixture repo: commit locally on main, do not push or open PRs.", 1_500_000);
} catch (e) { console.log("prompt:", String(e)); }
const entries = (await s.request({ type: "get_entries" })).data.entries as Rec[];
await s.close();

const states = entries.filter((e) => e.type === "custom" && e.customType === "pstack-state").map((e) => e.data);
check("poteto: pstack-state poteto=true recorded from the user command", states.some((d) => d.active && d.poteto), JSON.stringify(states));
const commits = sh(`git log --format=%H%x09%s ${base}..HEAD --reverse`).out.trim().split("\n").filter(Boolean);
check("poteto: made local commits", commits.length >= 1, commits.map((c) => c.split("\t")[1]).join(" | "));
// Red→green: find a commit where tests fail (new test, old code) before the fix lands.
let redCommit = "";
for (const line of commits) {
  const sha = line.split("\t")[0];
  sh(`git stash -u -q 2>/dev/null; git checkout -q ${sha}`);
  const t = sh("bun test 2>&1");
  if (t.code !== 0 && !redCommit) redCommit = sha;
}
sh("git checkout -q main");
const finalTest = sh("bun test 2>&1");
const value = sh(`bun -e 'import {mean} from "./src/stats"; console.log(mean([1,2,3]), mean([2,4]), mean([5]))'`).out.trim();
check("poteto: final tests pass", finalTest.code === 0, finalTest.out.split("\n").slice(-3).join(" "));
check("poteto: bug fixed (mean = 2, 3, 5)", value === "2 3 5", value);
const diff = sh(`git diff --stat ${base}..HEAD`).out;
check("poteto: fix touches src/stats.ts and adds/changes a test", /stats\.ts/.test(diff) && /test/.test(diff), diff.replace(/\n/g, " "));
// Failing test proven: either a red commit in history, or the run executed tests that failed before the fix.
const bashRuns = toolStarts(s.records, "bash").map((r) => String(r.args?.command ?? ""));
const testRuns = s.records.filter((r) => r.type === "tool_execution_end" && r.toolName === "bash");
const sawRed = testRuns.some((r) => /\bfail\b|\(fail\)|[1-9]\d* fail/.test(JSON.stringify(r.result?.content ?? "")));
check("poteto: failing test observed before fix (red commit or red run)", !!redCommit || sawRed, redCommit ? `red commit ${redCommit.slice(0, 7)}` : sawRed ? "red bash run" : "none");
check("poteto: no push / PR attempted", !bashRuns.some((c) => /git push|gh pr/.test(c)), `${bashRuns.length} bash calls`);
writeFileSync(join(R, "runs/1-results.json"), JSON.stringify(results, null, 2));
writeFileSync(join(R, "runs/1-poteto/git-log.txt"), sh(`git log --stat ${base}..HEAD`).out);
