// Validate the generated skills/ and agents/ trees. Exit 1 on any finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CURSOR_ALLOWLIST, EXTERNAL_SKILLS, isBinary, isValidSkillName, stripUrls } from "./rules";

export type Finding = { file: string; message: string };

/**
 * Local Cursor paths outside URLs: `~/.cursor`, `$HOME/.cursor`, and any `.cursor/` segment
 * (bare, `./`, `../`, `<dir>/`). `foo.cursor/` and `endCursor` are not paths.
 */
export function findCursorPaths(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of stripUrls(text).matchAll(/(?:~|\$HOME)\/\.cursor\b[^\s`'")]*|(?<![\w-])\.cursor\/[^\s`'")]*/g)) {
    const hit = m[0];
    const allowed = CURSOR_ALLOWLIST.some((a) => a.file === file && hit.startsWith(a.text));
    if (!allowed) out.push({ file, message: `cursor path: ${hit}` });
  }
  return out;
}

export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return fields;
}

export function checkSkillFrontmatter(file: string, dirName: string, text: string): Finding[] {
  const fm = parseFrontmatter(text);
  if (!fm) return [{ file, message: "missing frontmatter" }];
  const out: Finding[] = [];
  const name = fm.name ?? "";
  if (!isValidSkillName(name)) out.push({ file, message: `invalid skill name: ${JSON.stringify(name)}` });
  else if (name !== dirName) out.push({ file, message: `name ${name} != directory ${dirName}` });
  if (!fm.description) out.push({ file, message: "missing description" });
  return out;
}

const BOLD = String.raw`\*\*([a-z0-9-]+)\*\*`;
const JOIN = String.raw`(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)`;
// `**a**, **b** and **c** principle skills`, `The **x** skill`, `the **y** principle`.
const BOLD_NC = String.raw`\*\*[a-z0-9-]+\*\*`;
const BOLD_LIST = new RegExp(`${BOLD}((?:${JOIN}${BOLD_NC})*)\\s+(principle\\s+skills?|principles?|skills?)\\b`, "g");

/**
 * Skill references in prose: bold names (or bold lists) followed by skill/principle, any
 * `**principle-x**`, `Use **x** for|whenever|when|to`, and `/x` slash commands (bare, backticked,
 * parenthesised, or quoted; `/x/...` paths are not commands).
 */
export function findSkillRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(BOLD_LIST)) {
    const names = [m[1]!, ...[...m[2]!.matchAll(new RegExp(BOLD, "g"))].map((x) => x[1]!)];
    const principle = m[3]!.startsWith("principle");
    for (const n of names) refs.add(principle && !n.startsWith("principle-") ? `principle-${n}` : n);
  }
  for (const m of text.matchAll(/\*\*(principle-[a-z0-9-]+)\*\*/g)) refs.add(m[1]!);
  for (const m of text.matchAll(/\b[Uu]se \*\*([a-z0-9-]+)\*\* (?:for|whenever|when|to)\b/g)) refs.add(m[1]!);
  for (const m of text.matchAll(/(?<=^|[\s(`"'])\/([a-z][a-z0-9-]+)(?=[\s`"'),.:;]|$)/gm)) refs.add(m[1]!);
  return [...refs];
}

// Slash tokens that are filesystem paths or Pi's own commands, not skills
// (e.g. "keep the harness in `/tmp`", "`/skill:<name>`", "`/reload`").
const SLASH_NOISE = new Set(["tmp", "skill", "reload"]);

export function checkSkillRefs(file: string, text: string, known: Set<string>): Finding[] {
  return findSkillRefs(stripUrls(text))
    .filter((r) => !known.has(r) && !(r in EXTERNAL_SKILLS) && !SLASH_NOISE.has(r))
    .map((r) => ({ file, message: `unresolved skill reference: ${r}` }));
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    // Installed script dependencies (gitignored) are not vendored output.
    if (n === "node_modules") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function checkRepo(root: string): { findings: Finding[]; files: number; skills: number } {
  // extras/skills holds this package's own (non-vendored) skills; they are checked the same way.
  const skillRoots = [join(root, "skills"), join(root, "extras", "skills")];
  const files = [...skillRoots.flatMap(walk), ...walk(join(root, "agents"))];
  const skillFiles = files.filter((f) => basename(f) === "SKILL.md" && skillRoots.includes(dirname(dirname(f))));
  const known = new Set(skillFiles.map((f) => basename(dirname(f))));
  const findings: Finding[] = [];
  for (const abs of files) {
    const file = relative(root, abs);
    const data = readFileSync(abs);
    if (isBinary(data)) continue;
    findings.push(...findCursorPaths(file, data.toString("utf8")));
  }
  for (const abs of skillFiles) {
    const file = relative(root, abs);
    const text = readFileSync(abs, "utf8");
    findings.push(...checkSkillFrontmatter(file, basename(dirname(abs)), text));
    findings.push(...checkSkillRefs(file, text, known));
  }
  return { findings, files: files.length, skills: skillFiles.length };
}

if (import.meta.main) {
  const { findings, files, skills } = checkRepo(join(import.meta.dir, ".."));
  for (const f of findings) console.log(`✗ ${f.file}: ${f.message}`);
  console.log(`checked ${files} files, ${skills} skills: ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}
