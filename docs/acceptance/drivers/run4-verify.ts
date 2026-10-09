// 4: /create-verification-skill on a fixture CLI; then a fresh session loads /skill:verify-* and executes it.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";
import { drivesMean24, evidenceProves, execsCli } from "./verify-checks.ts";

const R = process.env.ACC_ROOT!;
const cwd = join(R, "work4");
if (process.env.REUSE !== "1") cpSync(join(R, "work1"), cwd, { recursive: true }); // fixed mean from item 1
writeFileSync(join(cwd, "src/cli.ts"), `import { mean } from "./stats";
const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "mean" || rest.length === 0) { console.error("usage: calc mean <n...>"); process.exit(2); }
const xs = rest.map(Number);
if (xs.some(Number.isNaN)) { console.error("calc: not a number"); process.exit(2); }
console.log(String(mean(xs)));
`);
writeFileSync(join(cwd, "README.md"), "# calc-fixture\n\nCLI: `bun src/cli.ts mean 1 2 3` prints `2`. Bad input exits 2 with usage on stderr.\n\n`bun test` runs unit tests.\n");
const sh = (cmd: string) => { const p = Bun.spawnSync(["bash", "-lc", cmd], { cwd, env: process.env }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }; };
if (process.env.REUSE !== "1") sh("git add -A && git commit -qm 'add calc CLI'");

const reuse = process.env.REUSE === "1";
const s = start({ cwd, runDir: join(R, "runs/4-verify-create"), args: ["--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
try { if (!reuse) await s.prompt("/create-verification-skill", 1_500_000); } catch (e) { console.log("prompt:", String(e)); }
await s.close();
const skillsDir = join(cwd, ".pi/skills");
const made = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => d.startsWith("verify-")) : [];
check("verify: .pi/skills/verify-* created", made.length === 1, made.join(","));
const name = made[0];
if (name) {
  const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  check("verify: frontmatter name matches dir and has description", !!fm && new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fm[1]) && /^description:\s*\S/m.test(fm[1]), fm?.[1].slice(0, 200));
  const sections = ["Launch", "Doctor", "Drive", "Evidence", "Cleanup"].filter((h) => !new RegExp(`^#+ .*${h}`, "mi").test(text));
  check("verify: has Launch/Doctor/Drive/Evidence/Cleanup sections", sections.length === 0, sections.length ? `missing ${sections}` : "all");
  const feats = existsSync(join(skillsDir, name, "features")) ? readdirSync(join(skillsDir, name, "features")) : [];
  check("verify: feature map seeded (README + >=1 feature)", feats.includes("README.md") && feats.length >= 2, feats.join(","));
  // A CLI run = a bash call that executes the CLI or the skill's helper (verify-checks.ts, unit-tested).
  const endsOf = (rs: Rec[]) => new Map(rs.filter((r) => r.type === "tool_execution_end" && r.toolName === "bash").map((r) => [r.toolCallId, r]));
  const genEnds = endsOf(s.records);
  const ranCli = toolStarts(s.records, "bash").some((r) => execsCli(String(r.args?.command)) && genEnds.get(r.toolCallId)?.isError === false);
  if (!reuse) check("verify: generator executed the generated skill once (a CLI/helper call that succeeded)", ranCli);

  // Fresh session: Pi discovers the project skill and the agent executes it.
  // Evidence written by this run: any file under the repo (outside .git) created or rewritten after this point.
  const snapshot = () => {
    const out = new Map<string, number>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.set(p, statSync(p).mtimeMs);
      }
    };
    walk(cwd);
    return out;
  };
  const before = snapshot();
  const s2 = start({ cwd, runDir: join(R, "runs/4-verify-use"), args: ["--approve", "--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
  const cmds = (await s2.request({ type: "get_commands" })).data.commands as Rec[];
  const found = cmds.find((c) => c.name === `skill:${name}`);
  check("verify: fresh Pi session (project trust approved via --approve) discovers the project skill", !!found, found?.sourceInfo?.path);
  try { await s2.prompt(`/skill:${name} Verify that \`mean 2 4\` prints 3. Report the evidence path.`, 900_000); } catch (e) { console.log("prompt2:", String(e)); }
  await s2.close();
  // The call that drove `mean 2 4` (correlated with its own result by toolCallId) must have succeeded.
  const ends = endsOf(s2.records);
  const runs = toolStarts(s2.records, "bash").map((r) => ({ cmd: String(r.args?.command), end: ends.get(r.toolCallId) })).filter((x) => drivesMean24(x.cmd));
  const good = runs.find((x) => x.end && !x.end.isError);
  check("verify: fresh session ran the CLI/helper with `mean 2 4` and that call succeeded (same toolCallId)", !!good, (good ?? runs[0])?.cmd.slice(0, 200) ?? "no matching call");
  // Evidence produced by this run proves stdout 3 and exit 0 (single transcript or split .stdout/.exit files).
  const fresh: Record<string, string> = {};
  for (const [p, t] of snapshot()) if (before.get(p) !== t && statSync(p).size < 100_000) fresh[p] = readFileSync(p, "utf8");
  check("verify: evidence written by this run proves `mean 2 4` → 3, exit 0", evidenceProves(fresh), Object.keys(fresh).map((p) => p.slice(cwd.length + 1)).join(",") || "no new files");
}
writeFileSync(join(R, `runs/4-results${reuse ? "-reuse" : ""}.json`), JSON.stringify(results, null, 2));
