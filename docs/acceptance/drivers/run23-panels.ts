// 2: /arena with two configured models; 3: /swarm with 3 workers. Assertions from Task records on disk.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const tasksDir = join(HOME, "tasks");
const metas = (): Rec[] => (existsSync(tasksDir) ? readdirSync(tasksDir) : [])
  .map((d) => join(tasksDir, d, "meta.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")));
const which = process.argv[2] ?? "both";

if (which !== "swarm") {
  const cwd = join(R, "work2");
  cpSync(join(R, "fixture-src"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const s = start({ cwd, runDir: join(R, "runs/2-arena"), args: ["--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
  try {
    await s.prompt("/arena Write `src/median.ts` exporting `median(xs: number[]): number` (sorted copy, even length averages the middle two). Each runner works in its own copy; pick the best one and apply it here. Keep it small.", 1_800_000);
  } catch (e) { console.log("prompt:", String(e)); }
  await s.close();
  const mine = metas().filter((m) => !before.has(m.id) && !m.parentTaskId);
  writeFileSync(join(R, "runs/2-arena/tasks.json"), JSON.stringify(mine, null, 2));
  const models = new Set(mine.map((m) => m.model));
  check("arena: >=2 Tasks launched", mine.length >= 2, `${mine.length} tasks: ${mine.map((m) => `${m.id}:${m.model}:${m.status}`).join(", ")}`);
  check("arena: runners used both configured arena models", ["local-openai/glm-5.3-flash", "local-openai/deepseek-v4-flash"].every((x) => models.has(x)), [...models].join(","));
  check("arena: all Tasks completed", mine.length > 0 && mine.every((m) => m.status === "done"), mine.map((m) => m.status).join(","));
  const out = Bun.spawnSync(["bun", "-e", `import {median} from "./src/median"; console.log(median([3,1,2]), median([4,1,3,2]))`], { cwd, env: process.env });
  check("arena: winning result applied (median works)", out.stdout.toString().trim() === "2 2.5", out.stdout.toString().trim() + out.stderr.toString().slice(0, 200));
}

if (which !== "arena") {
  const cwd = join(R, "work3");
  cpSync(join(R, "fixture-src"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const s = start({ cwd, runDir: join(R, "runs/3-swarm"), args: ["--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
  try {
    await s.prompt("/swarm 3 Add three independent helpers, one per worker, each in its own file with a bun test: `src/sum.ts` (sum), `src/max.ts` (max of non-empty list), `src/range.ts` (range(n) -> [0..n-1]). Integrate all three here and make `bun test` pass.", 1_800_000);
  } catch (e) { console.log("prompt:", String(e)); }
  await s.close();
  const mine = metas().filter((m) => !before.has(m.id) && !m.parentTaskId);
  writeFileSync(join(R, "runs/3-swarm/tasks.json"), JSON.stringify(mine, null, 2));
  check("swarm: >=3 distinct worker Tasks", new Set(mine.map((m) => m.id)).size >= 3, `${mine.length}: ${mine.map((m) => `${m.id}:${m.model}:${m.status}`).join(", ")}`);
  check("swarm: workers on configured swarm model", mine.length > 0 && mine.every((m) => m.model === "local-openai/deepseek-v4-flash"), [...new Set(mine.map((m) => m.model))].join(","));
  check("swarm: all workers completed", mine.length > 0 && mine.every((m) => m.status === "done"), mine.map((m) => m.status).join(","));
  const starts = mine.map((m) => Date.parse(m.startedAt)).sort();
  const ends = mine.map((m) => Date.parse(m.endedAt)).sort();
  check("swarm: workers overlapped in time (ran concurrently)", mine.length >= 2 && starts[1] < ends[0], `starts ${starts.map((t) => t - starts[0])} firstEnd ${ends[0] - starts[0]}`);
  const files = ["sum", "max", "range"].map((f) => existsSync(join(cwd, "src", f + ".ts")));
  const t = Bun.spawnSync(["bun", "test"], { cwd, env: process.env });
  check("swarm: all three helpers integrated and bun test passes", files.every(Boolean) && t.exitCode === 0, `files=${files} test=${t.exitCode} ${t.stderr.toString().split("\n").slice(-3).join(" ")}`);
}
writeFileSync(join(R, `runs/23-${which}-results.json`), JSON.stringify(results, null, 2));
