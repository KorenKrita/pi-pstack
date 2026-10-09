// 7: extra skills — interrogate, reflect (+ create-skill hand-off), maintain-verification-skill (no remote → no PR), orchestrate (orch.ts store), create-skill test loop.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const which = process.argv[2] ?? "all";
const ui = (q: Rec) => {
  if (q.method === "confirm") return { confirmed: true };
  if (q.method === "select") { const o: string[] = q.options ?? []; return { value: o.find((x) => /yes|proceed|apply|accept|all|approve|go|continue/i.test(x)) ?? o[0] }; }
  return { cancelled: true };
};
const metas = (): Rec[] => (existsSync(join(HOME, "tasks")) ? readdirSync(join(HOME, "tasks")) : []).map((d) => JSON.parse(readFileSync(join(HOME, "tasks", d, "meta.json"), "utf8")));
const newTasks = (before: Set<string>) => metas().filter((m) => !before.has(m.id));
const sh = (cwd: string, cmd: string) => { const p = Bun.spawnSync(["bash", "-lc", cmd], { cwd, env: process.env }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }; };
const run = async (name: string, cwd: string, msg: string, args: string[] = [], timeout = 1_800_000) => {
  const s = start({ cwd, runDir: join(R, `runs/7-${name}`), args: ["--session-dir", join(R, "sessions7"), ...args], ui });
  try { await s.prompt(msg, timeout); } catch (e) { console.log(name, "prompt:", String(e)); }
  const entries = (await s.request({ type: "get_entries" })).data.entries as Rec[];
  const state = (await s.request({ type: "get_state" })).data;
  await s.close();
  return { s, entries, state };
};

if (which === "all" || which === "interrogate") {
  const cwd = join(R, "work7i");
  cpSync(join(R, "work1"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const { s } = await run("interrogate", cwd, "/interrogate the last commit (HEAD) in this repo.");
  const ts = newTasks(before).filter((m) => !m.parentTaskId);
  const cfg = toolStarts(s.records, "pstack_config").map((r) => r.args?.action);
  check("interrogate: read config via pstack_config", cfg.includes("read"), cfg.join(","));
  check("interrogate: one reviewer per configured entry (2), distinct models", ts.length >= 2 && new Set(ts.map((m) => m.model)).size >= 2, ts.map((m) => `${m.model}:${m.status}`).join(","));
  const last = s.records.filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1);
  const text = JSON.stringify(last?.message?.content ?? "");
  check("interrogate: final report has Act on / Consider buckets", /Act on/i.test(text) && /Consider/i.test(text), text.slice(0, 160));
}

if (which === "all" || which === "reflect") {
  // Reflect over a real prior session in the same workspace: run a short session first, then /reflect in it.
  const cwd = join(R, "work7r");
  cpSync(join(R, "work1"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const s = start({ cwd, runDir: join(R, "runs/7-reflect"), args: ["--session-dir", join(R, "sessions7r")], ui });
  await s.prompt("Run `bun test` here and tell me how many tests pass. Note: I always want test counts reported as 'N/N passing'.");
  await s.prompt("/reflect", 1_800_000).catch((e) => console.log("reflect:", String(e)));
  const sessionFile = (await s.request({ type: "get_state" })).data.sessionFile as string;
  await s.close();
  const ts = newTasks(before);
  const reviewers = ts.filter((m) => !m.parentTaskId);
  check("reflect: >=3 reviewers + synthesizer Tasks (agent mode)", reviewers.length >= 4 && reviewers.every((m) => m.readonly === false), reviewers.map((m) => `${m.description}:${m.model}:${m.readonly}:${m.status}`).join(" | "));
  const prompts = reviewers.map((m) => readFileSync(join(HOME, "tasks", m.id, "prompt.md"), "utf8"));
  check("reflect: reviewers were given this workspace's own transcript path", prompts.some((p) => p.includes(sessionFile) || p.includes(join(R, "sessions7r"))), sessionFile);
  check("reflect: no cross-workspace transcript glob", !toolStarts(s.records).some((r) => /sessions\/\*/.test(JSON.stringify(r.args))));
  const last = s.records.filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1);
  const text = JSON.stringify(last?.message?.content ?? "");
  check("reflect: produced Accepted/Rejected/Backlog-shaped outcome", /accept/i.test(text) && /(reject|backlog)/i.test(text), text.slice(0, 200));
}

if (which === "all" || which === "maintain") {
  const cwd = join(R, "work7m");
  cpSync(join(R, "work4"), cwd, { recursive: true });
  sh(cwd, "git add -A && git commit -qm 'verify skill' || true");
  const headBefore = sh(cwd, "git rev-parse HEAD").out.trim();
  const before = new Set(metas().map((m) => m.id));
  const { s } = await run("maintain", cwd, "/maintain-verification-skill This fixture has no git remote; if corrections are proven, commit them on a local branch and report instead of opening a PR.", ["--approve"]);
  const ts = newTasks(before);
  const drove = toolStarts(s.records, "bash").filter((r) => /cli\.ts|drive\.sh/.test(String(r.args?.command)));
  check("maintain: parallel source readers launched (>=1 Task per feature)", ts.length >= 2, ts.map((m) => m.description).join(" | "));
  check("maintain: live session drove features", drove.length >= 2, `${drove.length} drives`);
  const branches = sh(cwd, "git branch --format='%(refname:short)'").out.trim();
  const last = JSON.stringify(s.records.filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message?.content ?? "");
  check("maintain: outcome reported clean|changed|blocked", /\b(clean|changed|blocked)\b/i.test(last), last.slice(0, 200));
  check("maintain: no push / gh pr", !toolStarts(s.records, "bash").some((r) => /git push|gh pr/.test(String(r.args?.command))), `branches: ${branches.replace(/\n/g, ",")} head ${headBefore.slice(0, 7)}`);
}

if (which === "all" || which === "orchestrate") {
  const cwd = join(R, "work7o");
  cpSync(join(R, "fixture-src"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const { s } = await run("orchestrate", cwd, "/poteto-mode Orchestrate this as a multi-unit job using the orchestrate playbook and its orch store: add `src/min.ts` (min of non-empty list) and `src/product.ts` (product of a list), each with a bun test, as two independent units dispatched to subagents, then integrate on main with local commits. Local fixture: do not push.", [], 2_400_000);
  const ts = newTasks(before);
  const orchCalls = toolStarts(s.records, "bash").map((r) => String(r.args?.command)).filter((c) => /orch\.ts/.test(c));
  const stores = existsSync(join(HOME, "projects")) ? sh(HOME, "find projects -path '*orchestrate*' -name '*.tsv' -o -path '*orchestrate*' -name '*.json' | head -20").out.trim() : "";
  check("orchestrate: used orch.ts store CLI", orchCalls.length >= 2, orchCalls.slice(0, 4).map((c) => c.replace(/.*orch\.ts/, "orch.ts").slice(0, 60)).join(" | "));
  check("orchestrate: store files under $PSTACK_HOME/projects/*/orchestrate", stores.length > 0, stores.replace(/\n/g, ","));
  check("orchestrate: >=2 subagent Tasks", ts.length >= 2, ts.map((m) => `${m.description}:d${m.depth}:${m.status}`).join(" | "));
  const t = sh(cwd, "bun test");
  check("orchestrate: both units integrated, tests pass", existsSync(join(cwd, "src/min.ts")) && existsSync(join(cwd, "src/product.ts")) && t.code === 0, t.out.split("\n").slice(-3).join(" "));
  check("orchestrate: depth limit respected (<=2)", ts.every((m) => m.depth <= 2), ts.map((m) => m.depth).join(","));
}

if (which === "all" || which === "create-skill") {
  const cwd = join(R, "work7c");
  cpSync(join(R, "fixture-src"), cwd, { recursive: true });
  const before = new Set(metas().map((m) => m.id));
  const { s } = await run("create-skill", cwd, "/create-skill Create a project skill `release-notes` that drafts release notes from `git log` since the last tag (or all commits if none) for this repo. Run its test step.", ["--approve"]);
  const file = join(cwd, ".pi/skills/release-notes/SKILL.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  check("create-skill: .pi/skills/release-notes/SKILL.md written with name+description", /^---\n[\s\S]*?^name:\s*release-notes\s*$[\s\S]*?^description:\s*\S[\s\S]*?\n---/m.test(text), text.slice(0, 160));
  const ts = newTasks(before);
  check("create-skill: test prompts run in clean Task children", ts.length >= 1 && ts.every((m) => m.status === "done"), ts.map((m) => `${m.description}:${m.status}`).join(" | "));
  const briefs = ts.map((m) => readFileSync(join(HOME, "tasks", m.id, "prompt.md"), "utf8"));
  check("create-skill: child briefs point at the new SKILL.md", briefs.some((b) => b.includes("release-notes/SKILL.md")));
}
writeFileSync(join(R, `runs/7-${which}-results.json`), JSON.stringify(results, null, 2));
