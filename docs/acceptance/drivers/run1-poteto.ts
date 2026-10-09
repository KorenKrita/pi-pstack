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
// Red→green: a commit before the fix where `bun test` exits non-zero with a real failure count (N>0 fail),
// on unchanged src/stats.ts (old code, new test), followed by a later commit that changes src/stats.ts.
let redCommit = "";
let redIndex = -1;
for (const [i, line] of commits.entries()) {
  const sha = line.split("\t")[0];
  sh(`git stash -u -q 2>/dev/null; git checkout -q ${sha}`);
  const t = sh("bun test 2>&1");
  const oldCode = sh(`git diff --quiet ${base} ${sha} -- src/stats.ts`).code === 0;
  if (!redCommit && t.code !== 0 && /(^|\n)\s*[1-9]\d* fail\b/.test(t.out) && oldCode) { redCommit = sha; redIndex = i; }
}
sh("git checkout -q main");
const finalTest = sh("bun test 2>&1");
const value = sh(`bun -e 'import {mean} from "./src/stats"; console.log(mean([1,2,3]), mean([2,4]), mean([5]))'`).out.trim();
check("poteto: final tests pass", finalTest.code === 0, finalTest.out.split("\n").slice(-3).join(" "));
check("poteto: bug fixed (mean = 2, 3, 5)", value === "2 3 5", value);
const diff = sh(`git diff --stat ${base}..HEAD`).out;
check("poteto: fix touches src/stats.ts and adds/changes a test", /stats\.ts/.test(diff) && /test/.test(diff), diff.replace(/\n/g, " "));
// Failing test proven from history only (a test-output regex would also match a green "0 fail").
const bashRuns = toolStarts(s.records, "bash").map((r) => String(r.args?.command ?? ""));
const fixAfterRed = redIndex >= 0 && commits.slice(redIndex + 1).some((l) => sh(`git diff --quiet ${l.split("\t")[0]}~1 ${l.split("\t")[0]} -- src/stats.ts`).code !== 0);
check("poteto: red commit (N>0 failing tests on the old code) precedes the fix commit", !!redCommit && fixAfterRed, redCommit ? `red ${redCommit.slice(0, 7)}, fix after: ${fixAfterRed}` : "no red commit");
check("poteto: no push / PR attempted", !bashRuns.some((c) => /git push|gh pr/.test(c)), `${bashRuns.length} bash calls`);
writeFileSync(join(R, "runs/1-results.json"), JSON.stringify(results, null, 2));
writeFileSync(join(R, "runs/1-poteto/git-log.txt"), sh(`git log --stat ${base}..HEAD`).out);
