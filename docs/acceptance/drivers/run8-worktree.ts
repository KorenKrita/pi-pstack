// 8: Task isolation: "worktree" — the child works in $PSTACK_HOME/worktrees/<id> on branch pstack/<id>; the parent checkout is untouched.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const cwd = join(R, "work8");
cpSync(join(R, "fixture-src"), cwd, { recursive: true });
const sh = (dir: string, cmd: string) => { const p = Bun.spawnSync(["bash", "-lc", cmd], { cwd: dir, env: process.env }); return { code: p.exitCode, out: (p.stdout.toString() + p.stderr.toString()).trim() }; };
const metas = (): Rec[] => readdirSync(join(HOME, "tasks")).map((d) => JSON.parse(readFileSync(join(HOME, "tasks", d, "meta.json"), "utf8")));
const before = new Set(metas().map((m) => m.id));
const s = start({ cwd, runDir: join(R, "runs/8-worktree"), args: ["--no-session"], ui: () => ({ cancelled: true }) });
await s.prompt("/pstack on");
await s.prompt('Call Task once (foreground) with isolation: "worktree", description "wt", prompt: "Create src/wt.ts exporting `export const WT = 1;` and commit it with message \\"wt: add marker\\". Reply with the output of `pwd` and `git rev-parse --abbrev-ref HEAD`." Report the result verbatim.', 600_000);
await s.close();
const m = metas().find((x) => !before.has(x.id));
check("worktree: Task record has worktree path + branch pstack/<id>", !!m?.worktree && m.worktree.branch === `pstack/${m.id}` && m.worktree.path.startsWith(join(HOME, "worktrees")), JSON.stringify(m?.worktree));
if (m?.worktree) {
  check("worktree: child commit landed on the worktree branch", /wt: add marker/.test(sh(cwd, `git log --format=%s ${m.worktree.branch}`).out) && existsSync(join(m.worktree.path, "src/wt.ts")));
  check("worktree: parent checkout untouched (still main, no src/wt.ts, clean)", sh(cwd, "git rev-parse --abbrev-ref HEAD").out === "main" && !existsSync(join(cwd, "src/wt.ts")) && sh(cwd, "git status --porcelain").out === "", sh(cwd, "git status --porcelain").out);
  check("worktree: child cwd was the worktree", m.cwd === m.worktree.path || JSON.stringify(s.records).includes(m.worktree.path), m.cwd);
  check("worktree: kept for review (git worktree list)", sh(cwd, "git worktree list").out.includes(m.worktree.path));
}
writeFileSync(join(R, "runs/8-results.json"), JSON.stringify(results, null, 2));
