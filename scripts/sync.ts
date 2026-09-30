// Vendor Cursor's pstack (+ three cursor-team-kit skills) into skills/ and agents/, adapted for Pi.
// Usage: bun scripts/sync.ts [--upstream <dir>]
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { RULES, applyRules, normalizeSkillName } from "./rules";

export const UPSTREAM_REPO = "https://github.com/cursor/plugins";
export const UPSTREAM_COMMIT = "fae2c6ed95821bd85f614a73e4842e13229fa5e5";

const EXCLUDED_PSTACK_SKILLS = ["make-bot-ui"];
const TEAM_KIT_SKILLS = ["deslop", "control-ui", "control-cli"];
const OUTPUT_DIRS = ["skills", "agents"];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|lockb)$/i;

const root = join(import.meta.dir, "..");

async function resolveUpstream(): Promise<string> {
  const i = process.argv.indexOf("--upstream");
  if (i !== -1) {
    const dir = process.argv[i + 1];
    if (!dir) throw new Error("--upstream needs a directory");
    return dir;
  }
  const cache = join(root, ".upstream-cache");
  const head = existsSync(join(cache, ".git")) ? (await $`git -C ${cache} rev-parse HEAD`.nothrow().quiet().text()).trim() : "";
  if (head !== UPSTREAM_COMMIT) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    await $`git -C ${cache} init -q`;
    await $`git -C ${cache} remote add origin ${UPSTREAM_REPO}`;
    await $`git -C ${cache} sparse-checkout set pstack cursor-team-kit`;
    await $`git -C ${cache} fetch -q --depth 1 --filter=blob:none origin ${UPSTREAM_COMMIT}`;
    await $`git -C ${cache} checkout -q FETCH_HEAD`;
  }
  return cache;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Map of output path (relative to repo root) -> upstream source path. */
function plan(upstream: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (srcDir: string, destDir: string) => {
    for (const f of walk(srcDir)) out.set(join(destDir, relative(srcDir, f)), f);
  };
  const pstackSkills = join(upstream, "pstack/skills");
  for (const name of readdirSync(pstackSkills).sort()) {
    if (EXCLUDED_PSTACK_SKILLS.includes(name)) continue;
    add(join(pstackSkills, name), join("skills", name));
  }
  for (const name of TEAM_KIT_SKILLS) add(join(upstream, "cursor-team-kit/skills", name), join("skills", name));
  add(join(upstream, "pstack/agents"), "agents");
  return out;
}

function normalizeFrontmatterName(path: string, text: string, hits: Record<string, number>): string {
  if (!/(^|\/)SKILL\.md$/.test(path)) return text;
  return text.replace(/^(---\n[\s\S]*?^name:[ \t]*)(.+)$/m, (whole, prefix: string, name: string) => {
    const fixed = normalizeSkillName(name.trim().replace(/^["']|["']$/g, ""));
    if (fixed === name.trim()) return whole;
    hits["frontmatter-name"] = (hits["frontmatter-name"] ?? 0) + 1;
    return prefix + fixed;
  });
}

async function main() {
  const upstream = await resolveUpstream();
  const files = plan(upstream);
  const hits: Record<string, number> = {};
  let written = 0;

  for (const [dest, src] of files) {
    const target = join(root, dest);
    mkdirSync(dirname(target), { recursive: true });
    const raw = readFileSync(src);
    const next = BINARY_EXT.test(src)
      ? raw
      : Buffer.from(normalizeFrontmatterName(dest, applyRules(dest, raw.toString("utf8"), RULES, hits), hits));
    if (!existsSync(target) || !readFileSync(target).equals(next)) {
      writeFileSync(target, next);
      written++;
    }
    chmodSync(target, statSync(src).mode & 0o777);
  }

  let removed = 0;
  for (const dir of OUTPUT_DIRS) {
    if (!existsSync(join(root, dir))) continue;
    for (const f of walk(join(root, dir))) {
      if (!files.has(relative(root, f))) {
        rmSync(f);
        removed++;
      }
    }
    pruneEmptyDirs(join(root, dir));
  }

  console.log(`upstream: ${upstream} @ ${UPSTREAM_COMMIT}`);
  console.log(`files: ${files.size} vendored, ${written} written, ${removed} stale removed`);
  console.log("rule hits:");
  for (const id of [...RULES.map((r) => r.id), "frontmatter-name"]) console.log(`  ${String(hits[id] ?? 0).padStart(3)}  ${id}`);
  const dead = RULES.filter((r) => !hits[r.id]).map((r) => r.id);
  if (dead.length) console.log(`note: rules with 0 hits: ${dead.join(", ")}`);
}

function pruneEmptyDirs(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pruneEmptyDirs(p);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

if (import.meta.main) await main();
