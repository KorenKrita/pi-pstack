// 4: /create-verification-skill on a fixture CLI; then a fresh session loads /skill:verify-* and executes it.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, type Rec } from "./rpc.ts";

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
  const ranCli = toolStarts(s.records, "bash").some((r) => /src\/cli\.ts|calc/.test(String(r.args?.command)));
  if (!reuse) check("verify: generator executed the generated skill once (drove the CLI)", ranCli);

  // Fresh session: Pi discovers the project skill and the agent executes it.
  const s2 = start({ cwd, runDir: join(R, "runs/4-verify-use"), args: ["--approve", "--session-dir", join(R, "sessions")], ui: () => ({ cancelled: true }) });
  const cmds = (await s2.request({ type: "get_commands" })).data.commands as Rec[];
  const found = cmds.find((c) => c.name === `skill:${name}`);
  check("verify: fresh Pi session (project trust approved via --approve) discovers the project skill", !!found, found?.sourceInfo?.path);
  try { await s2.prompt(`/skill:${name} Verify that \`mean 2 4\` prints 3. Report the evidence path.`, 900_000); } catch (e) { console.log("prompt2:", String(e)); }
  await s2.close();
  const drove = toolStarts(s2.records, "bash").map((r) => String(r.args?.command)).filter((c) => /cli\.ts|calc/.test(c));
  const outs = s2.records.filter((r) => r.type === "tool_execution_end" && r.toolName === "bash").map((r) => JSON.stringify(r.result?.content ?? ""));
  check("verify: skill executed in fresh session (drove CLI, saw 3)", drove.length > 0 && outs.some((o) => /(^|[^0-9])3([^0-9]|$)/.test(o)), drove.slice(0, 3).join(" | "));
}
writeFileSync(join(R, `runs/4-results${reuse ? "-reuse" : ""}.json`), JSON.stringify(results, null, 2));
