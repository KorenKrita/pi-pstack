// 0: resource inventory, missing-config hard reject, /setup-pstack via RPC UI.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, check, results, toolStarts, toolEnds, type Rec } from "./rpc.ts";

const R = process.env.ACC_ROOT!;
const HOME = process.env.PSTACK_HOME!;
const cwd = join(R, "work0");
Bun.spawnSync(["mkdir", "-p", cwd]);
const mdc = join(HOME, "rules", "pstack-models.mdc");

// --- inventory + missing config ---
if (!process.env.SKIP_INV) {
  const s = start({ cwd, runDir: join(R, "runs/0a-inventory"), args: ["--no-session"] });
  const cmds = (await s.request({ type: "get_commands" })).data.commands as Rec[];
  writeFileSync(join(R, "runs/0a-inventory/commands.json"), JSON.stringify(cmds, null, 2));
  const skills = cmds.filter((c) => c.source === "skill");
  const ext = cmds.filter((c) => c.source === "extension");
  const foreign = cmds.filter((c) => !String(c.sourceInfo?.path ?? "").includes("/git/github.com/KorenKrita/pi-pstack/"));
  check("inventory: 50 skill commands from installed package", skills.length === 50, `skills=${skills.length}`);
  const foreignNonBuiltin = foreign.filter((c) => c.sourceInfo?.source !== "builtin");
  check("inventory: Pi builtins only besides pi-pstack", foreign.every((c) => c.sourceInfo?.source === "builtin"), foreign.map((c) => `${c.source}:${c.name}`).join(",") || "none");
  check("inventory: all non-builtin commands come from the installed pi-pstack package", foreignNonBuiltin.length === 0, foreign.map((c) => `${c.source}:${c.name}`).join(",") || "none foreign");
  check("inventory: /setup-pstack /poteto-mode /pstack /goal /loop present", ["setup-pstack", "poteto-mode", "pstack", "goal", "loop"].every((n) => cmds.some((c) => c.name === n)), ext.map((c) => c.name).join(","));
  check("precondition: no models config yet", !existsSync(mdc));
  const before = new Set(existsSync(join(HOME, "tasks")) ? readdirSync(join(HOME, "tasks")) : []);
  await s.prompt("/pstack on");
  await s.prompt('Call the Task tool exactly once with description "probe" and prompt "say hi". Then report the tool result verbatim.');
  const ends = toolEnds(s.records, "Task");
  const text = ends.map((e) => JSON.stringify(e.result?.content ?? "")).join(" ");
  check("missing config: Task call rejected with error", ends.length >= 1 && ends.every((e) => e.isError === true), text.slice(0, 200));
  check("missing config: error points to /setup-pstack", /setup-pstack/.test(text));
  const after = existsSync(join(HOME, "tasks")) ? readdirSync(join(HOME, "tasks")) : [];
  check("missing config: no task record / child created", after.filter((x) => !before.has(x)).length === 0, `new=${after.length - before.size}`);
  await s.close();
}

// --- /setup-pstack ---
{
  const PREF = ["deepseek-v4-flash", "glm-5.3-flash"];
  const uiLog: Rec[] = [];
  let arenaPicks = 0;
  const ui = (req: Rec): Rec | undefined => {
    uiLog.push({ method: req.method, title: req.title, options: req.options });
    if (req.method === "confirm") return { confirmed: true };
    if (req.method === "input" || req.method === "editor") return { value: req.prefill ?? "" };
    const opts: string[] = req.options ?? [];
    const multi = opts.includes("Done");
    if (multi) {
      // pick two distinct concrete models, then Done
      const unpicked = opts.filter((o) => o.startsWith("[ ]") && /flash/.test(o));
      const picked = opts.filter((o) => o.startsWith("[x]"));
      if (picked.length >= 2 || unpicked.length === 0) { arenaPicks++; return { value: "Done" }; }
      return { value: unpicked[0] };
    }
    for (const p of PREF) { const o = opts.find((x) => x.includes(p)); if (o) return { value: o }; }
    const rec = opts.find((x) => /recommend|inherit|default|unlimited|yes|all|accept|confirm/i.test(x));
    return { value: rec ?? opts[0] };
  };
  const s = start({ cwd, runDir: join(R, "runs/0b-setup"), args: ["--no-session"], ui });
  try { await s.prompt("/setup-pstack Use only models from the local-openai provider. For panels (arena runners) pick two different models.", 600_000); } catch (e) { console.log("setup prompt:", String(e)); }
  for (const e of s.records.filter((r) => r.type === "extension_error")) console.log("extension_error", e.event, e.error.slice(0, 120));
  writeFileSync(join(R, "runs/0b-setup/ui.json"), JSON.stringify(uiLog, null, 2));
  const starts = s.records.filter((r) => r.type === "tool_execution_start").map((r) => r.toolName);
  const firstConfigWrite = s.records.findIndex((r) => r.type === "tool_execution_start" && r.toolName === "pstack_config" && r.args?.action === "write");
  const firstTask = s.records.findIndex((r) => r.type === "tool_execution_start" && r.toolName === "Task");
  check("setup: real UI dialogs answered over RPC", uiLog.length > 0, `dialogs=${uiLog.length}`);
  check("setup: pstack_config write called", firstConfigWrite >= 0, starts.join(","));
  check("setup: no Task before config written", firstTask === -1 || firstTask > firstConfigWrite, `firstTask=${firstTask}`);
  check("setup: config file written", existsSync(mdc));
  await s.close();
  if (existsSync(mdc)) {
    const v = Bun.spawnSync(["bun", "-e", `
      import { parseModelsRule, ROLES } from "${process.env.PKG}/extensions/pstack/config";
      import { readFileSync } from "node:fs";
      const p = parseModelsRule(readFileSync(${JSON.stringify(mdc)}, "utf8"));
      console.log(JSON.stringify({ parsed: p, roles: ROLES.map((r) => ({ name: r.name, panel: !!r.panel })) }));`], { env: process.env });
    const out = JSON.parse(v.stdout.toString() || "null");
    writeFileSync(join(R, "runs/0b-setup/parsed.json"), JSON.stringify(out, null, 2));
    const missing = out.roles.filter((r: Rec) => !(r.name in out.parsed.roles)).map((r: Rec) => r.name);
    check("setup: every role configured", missing.length === 0, missing.join(",") || "all set");
    check("setup: no unknown/duplicate lines, frontmatter ok", !out.parsed.frontmatterError && out.parsed.unknownLines.length === 0 && out.parsed.duplicateRoles.length === 0);
    const panels = out.roles.filter((r: Rec) => r.panel).map((r: Rec) => [r.name, out.parsed.roles[r.name]]);
    const arena = panels.find(([n]: any) => /arena/.test(n));
    const ids = Array.isArray(arena?.[1]) ? new Set(arena[1]) : new Set();
    check("setup: an arena panel has >=2 distinct models", ids.size >= 2, JSON.stringify(panels));
    console.log(readFileSync(mdc, "utf8"));
  }
}
writeFileSync(join(R, "runs/0-results.json"), JSON.stringify(results, null, 2));
