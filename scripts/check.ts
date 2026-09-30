// Validate the generated skills/ and agents/ trees. Exit 1 on any finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CURSOR_ALLOWLIST, EXTERNAL_SKILLS, isValidSkillName } from "./rules";

export type Finding = { file: string; message: string };

const TEXT_EXT = /\.(md|mdc|ts|mjs|js|json|sh|tsv|yaml|yml|txt)$|\/[^./]+$/;

/** Paths starting with `~/.cursor` or `$HOME/.cursor`, or a bare `.cursor/` not preceded by a word/path char. */
export function findCursorPaths(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/(?:~|\$HOME)\/\.cursor\b[^\s`'")]*|(?<![\w/.~-])\.cursor\/[^\s`'")]*/g)) {
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

/** Skill references in prose: `the **x** skill`, `**principle-x**`, `**x** principle`, `/x` slash refs. */
export function findSkillRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/the \*\*([a-z0-9-]+)\*\* skill/g)) refs.add(m[1]!);
  for (const m of text.matchAll(/\*\*([a-z0-9-]+)\*\* principle/g)) refs.add(`principle-${m[1]!}`);
  for (const m of text.matchAll(/\*\*(principle-[a-z0-9-]+)\*\*/g)) refs.add(m[1]!);
  for (const m of text.matchAll(/(?<=^|[\s(`])\/([a-z][a-z0-9-]+)(?=[\s`),.:;]|$)/gm)) refs.add(m[1]!);
  return [...refs];
}

export function checkSkillRefs(file: string, text: string, known: Set<string>): Finding[] {
  return findSkillRefs(text)
    .filter((r) => !known.has(r) && !(r in EXTERNAL_SKILLS) && !SLASH_NOISE.has(r))
    .map((r) => ({ file, message: `unresolved skill reference: ${r}` }));
}

// Slash tokens that are paths, not skills (e.g. `/tmp/...`).
const SLASH_NOISE = new Set(["tmp"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function checkRepo(root: string): { findings: Finding[]; files: number; skills: number } {
  const files = [...walk(join(root, "skills")), ...walk(join(root, "agents"))];
  const skillFiles = files.filter((f) => basename(f) === "SKILL.md" && dirname(dirname(f)) === join(root, "skills"));
  const known = new Set(skillFiles.map((f) => basename(dirname(f))));
  const findings: Finding[] = [];
  for (const abs of files) {
    const file = relative(root, abs);
    if (!TEXT_EXT.test(file)) continue;
    const text = readFileSync(abs, "utf8");
    findings.push(...findCursorPaths(file, text));
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
