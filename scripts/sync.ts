// Vendor Cursor's pstack (+ three cursor-team-kit skills) into skills/ and agents/, adapted for Pi.
// Usage: bun scripts/sync.ts [--upstream <dir>]
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { RULES, applyRules, isBinary, namespaceSkills, normalizeSkillName, pstackName } from "./rules";

export const UPSTREAM_REPO = "https://github.com/cursor/plugins";
export const UPSTREAM_COMMIT = "fae2c6ed95821bd85f614a73e4842e13229fa5e5";

const EXCLUDED_PSTACK_SKILLS = ["make-bot-ui"];
/** This package's own skills under extras/skills/ (unprefixed names); vendored text may reference them. */
const EXTRA_SKILLS = ["create-skill"];
const TEAM_KIT_SKILLS = ["deslop", "control-ui", "control-cli"];
const OUTPUT_DIRS = ["skills", "agents"];

const root = join(import.meta.dir, "..");

async function resolveUpstream(): Promise<string> {
  const i = process.argv.indexOf("--upstream");
  if (i !== -1) {
    const dir = process.argv[i + 1];
    if (!dir) throw new Error("--upstream needs a directory");
    return dir;
  }
  const cache = join(root, ".upstream-cache");
  if (!(await hasCommit(cache, UPSTREAM_COMMIT))) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    await $`git -C ${cache} init -q`;
    await $`git -C ${cache} remote add origin ${UPSTREAM_REPO}`;
    await $`git -C ${cache} sparse-checkout set pstack cursor-team-kit`;
    await $`git -C ${cache} fetch -q --depth 1 --filter=blob:none origin ${UPSTREAM_COMMIT}`;
    // Checkout batch-fetches the sparse blobs so the tree reads below stay local.
    await $`git -C ${cache} checkout -q FETCH_HEAD`;
  }
  return cache;
}

async function hasCommit(dir: string, commit: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  return (await $`git -C ${dir} cat-file -e ${commit + "^{commit}"}`.nothrow().quiet()).exitCode === 0;
}

/** `logical` is the unprefixed path (`skills/<upstream name>/...`) that RULES' `files` globs match. */
export type UpstreamFile = { data: Buffer; mode: number; logical: string };

/**
 * Output path (relative to repo root) -> file, read from the git tree at `commit`, never from the
 * working tree, so a dirty or differently-checked-out upstream cannot change the output.
 */
export async function readUpstream(dir: string, commit: string = UPSTREAM_COMMIT): Promise<Map<string, UpstreamFile>> {
  if (!(await hasCommit(dir, commit))) throw new Error(`${dir} is not a git checkout containing ${commit}`);
  const paths = ["pstack/skills", "pstack/agents", ...TEAM_KIT_SKILLS.map((s) => `cursor-team-kit/skills/${s}`)];
  const listing = await $`git -C ${dir} ls-tree -r -z ${commit} -- ${paths}`.quiet().text();
  const out = new Map<string, UpstreamFile>();
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t") as [string, string];
    const [mode, type, sha] = meta.split(" ") as [string, string, string];
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error(`unsupported entry ${mode} ${type} ${path}`);
    const logical = logicalPath(path);
    if (!logical) continue;
    const data = Buffer.from(await $`git -C ${dir} cat-file blob ${sha}`.quiet().arrayBuffer());
    out.set(logical.replace(/^skills\/([^/]+)\//, (_, n: string) => `skills/${pstackName(n)}/`), {
      data,
      mode: mode === "100755" ? 0o755 : 0o644,
      logical,
    });
  }
  return out;
}

function logicalPath(path: string): string | null {
  let m = path.match(/^pstack\/skills\/([^/]+)\/(.+)$/);
  if (m) return EXCLUDED_PSTACK_SKILLS.includes(m[1]!) ? null : `skills/${m[1]}/${m[2]}`;
  m = path.match(/^cursor-team-kit\/skills\/([^/]+)\/(.+)$/);
  if (m) return `skills/${m[1]}/${m[2]}`;
  m = path.match(/^pstack\/agents\/(.+)$/);
  return m ? `agents/${m[1]}` : null;
}

/**
 * Output text for one vendored file: RULES (matched on the logical path), then the pstack- skill namespace
 * (`names`: every unprefixed skill name this package ships), then the frontmatter name.
 */
export function adaptText(file: UpstreamFile, names: Set<string>, hits: Record<string, number> = {}): string {
  const text = namespaceSkills(applyRules(file.logical, file.data.toString("utf8"), RULES, hits), names, hits);
  return normalizeFrontmatterName(file.logical, text, hits);
}

/** Unprefixed names of every skill this package ships: vendored ones plus extras/skills (create-skill). */
export function shippedSkillNames(files: Map<string, UpstreamFile>): Set<string> {
  const names = [...files.values()].flatMap((f) => f.logical.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? []);
  return new Set([...names, ...EXTRA_SKILLS]);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function normalizeFrontmatterName(path: string, text: string, hits: Record<string, number>): string {
  if (!/(^|\/)SKILL\.md$/.test(path)) return text;
  return text.replace(/^(---\n[\s\S]*?^name:[ \t]*)(.+)$/m, (whole, prefix: string, name: string) => {
    const fixed = pstackName(normalizeSkillName(name.trim().replace(/^["']|["']$/g, "")));
    if (fixed === name.trim()) return whole;
    hits["frontmatter-name"] = (hits["frontmatter-name"] ?? 0) + 1;
    return prefix + fixed;
  });
}

async function main() {
  const upstream = await resolveUpstream();
  const files = await readUpstream(upstream);
  const hits: Record<string, number> = {};
  const { written, removed } = writeOutput(root, files, hits);

  console.log(`upstream: ${upstream} @ ${UPSTREAM_COMMIT}`);
  console.log(`files: ${files.size} vendored, ${written} written, ${removed} stale removed`);
  console.log("rule hits:");
  for (const id of [...RULES.map((r) => r.id), "skill-namespace", "frontmatter-name"]) console.log(`  ${String(hits[id] ?? 0).padStart(3)}  ${id}`);
  const dead = RULES.filter((r) => !hits[r.id]).map((r) => r.id);
  if (dead.length) console.log(`note: rules with 0 hits: ${dead.join(", ")}`);
}

/** Write `files` under `root`, then move stale files in OUTPUT_DIRS to the trash. `trashCmd` is for tests. */
export function writeOutput(
  root: string,
  files: Map<string, UpstreamFile>,
  hits: Record<string, number> = {},
  trashCmd = "trash",
): { written: number; removed: number } {
  const names = shippedSkillNames(files);
  let written = 0;

  // Stale generated files go to the system trash, not rm, so a bad sync stays recoverable. Find them and
  // check `trash` (macOS 14+ /usr/bin/trash, or e.g. trash-cli) before writing anything.
  const stale = OUTPUT_DIRS.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : [])).filter(
    (f) => !files.has(relative(root, f)),
  );
  if (stale.length && !Bun.which(trashCmd)) {
    throw new Error(`${stale.length} stale generated file(s) to remove, but no \`trash\` command on PATH; nothing was written.`);
  }

  for (const [dest, file] of files) {
    const target = join(root, dest);
    mkdirSync(dirname(target), { recursive: true });
    const next = isBinary(file.data) ? file.data : Buffer.from(adaptText(file, names, hits));
    if (!existsSync(target) || !readFileSync(target).equals(next)) {
      writeFileSync(target, next);
      written++;
    }
    chmodSync(target, file.mode);
  }

  for (const f of stale) {
    const r = Bun.spawnSync([trashCmd, f]);
    if (r.exitCode !== 0) throw new Error(`trash ${f} failed: ${r.stderr.toString()}`);
  }
  for (const dir of OUTPUT_DIRS) if (existsSync(join(root, dir))) pruneEmptyDirs(join(root, dir));
  return { written, removed: stale.length };
}

function pruneEmptyDirs(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pruneEmptyDirs(p);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

if (import.meta.main) await main();
