// Pure parsing for per-turn injection: always-apply rules (R3b) and skill frontmatter fields
// `mode` / `reminder` / `paths` / `disable-model-invocation` (R3c/d).
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AlwaysApplyRule {
  file: string;
  body: string;
}

/** Parse one .mdc rule. Returns the body when `alwaysApply: true`, null when not always-apply; throws on malformed frontmatter. */
export function parseAlwaysApplyRule(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n") || normalized.indexOf("\n---", 3) === -1) {
    throw new Error("missing frontmatter");
  }
  const { frontmatter, body } = parseFrontmatter(normalized);
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error("frontmatter is not a mapping");
  }
  return frontmatter.alwaysApply === true ? body : null;
}

/** Read `<rulesDir>/*.mdc` (sorted by name). Malformed files are skipped and reported in `warnings`. */
export function loadAlwaysApplyRules(rulesDir: string): { rules: AlwaysApplyRule[]; warnings: string[] } {
  let names: string[];
  try {
    names = readdirSync(rulesDir).filter((n) => n.endsWith(".mdc")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], warnings: [] };
    throw error;
  }
  const rules: AlwaysApplyRule[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const file = join(rulesDir, name);
    try {
      const body = parseAlwaysApplyRule(readFileSync(file, "utf8"));
      if (body !== null) rules.push({ file, body });
    } catch (error) {
      warnings.push(`pstack: skipped rule ${file}: ${(error as Error).message}`);
    }
  }
  return { rules, warnings };
}

export interface SkillMeta {
  name: string;
  mode: boolean;
  reminder?: string;
  paths: string[];
  disableModelInvocation: boolean;
}

/** Read the pstack-relevant frontmatter of a SKILL.md. `fallbackName` is the skill directory name. */
export function parseSkillMeta(text: string, fallbackName: string): SkillMeta {
  const { frontmatter: fm } = parseFrontmatter(text);
  const rawPaths = fm.paths;
  const paths = (Array.isArray(rawPaths) ? rawPaths : typeof rawPaths === "string" ? [rawPaths] : []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const meta: SkillMeta = {
    name: typeof fm.name === "string" && fm.name ? fm.name : fallbackName,
    mode: fm.mode === true,
    paths,
    disableModelInvocation: fm["disable-model-invocation"] === true,
  };
  if (typeof fm.reminder === "string" && fm.reminder.trim()) meta.reminder = fm.reminder.trim();
  return meta;
}

/** Reminders of `mode: true` skills, in skill order (R3c). */
export function modeReminders(skills: readonly SkillMeta[]): string[] {
  return skills.filter((s) => s.mode && s.reminder).map((s) => s.reminder as string);
}

export function pathHintKey(skill: string, glob: string): string {
  return `${skill}\u0000${glob}`;
}

/**
 * Path hints (R3d) for a file touched by read/edit/write. The path is matched relative to `cwd`
 * (absolute paths outside cwd are matched as given). Hints already in `shown` are skipped; the
 * caller adds the returned keys to `shown` so each fires once per session.
 */
export function pathHints(
  skills: readonly SkillMeta[],
  touchedPath: string,
  cwd: string,
  shown: ReadonlySet<string>,
): { key: string; text: string }[] {
  const rel = isAbsolute(touchedPath) ? relative(cwd, touchedPath) : touchedPath;
  const candidate = (rel.startsWith("..") ? touchedPath : rel).split(sep).join("/");
  const hints: { key: string; text: string }[] = [];
  for (const skill of skills) {
    for (const glob of skill.paths) {
      const key = pathHintKey(skill.name, glob);
      if (shown.has(key) || !matchesGlob(candidate, glob)) continue;
      hints.push({ key, text: `Files matching ${glob} were touched; skill ${skill.name} applies — read it if you have not.` });
    }
  }
  return hints;
}
