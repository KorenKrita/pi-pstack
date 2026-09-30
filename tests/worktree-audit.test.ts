// Runs the generated worktree-audit.sh against a real temp repo + fake HOME with Pi sessions.
import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../skills/poteto-mode/scripts/worktree-audit.sh");
const slug = (p: string) => `--${p.replace(/^\//, "").replace(/[/:]/g, "-")}--`;

async function audit(sessionCwd: "main" | "wt" | null) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-audit-")));
  const main = join(base, "repo");
  const wt = join(base, "repo-wt");
  const home = join(base, "home");
  mkdirSync(main);
  await $`git -C ${main} init -q -b main && git -C ${main} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
  await $`git -C ${main} branch -q feature && git -C ${main} worktree add -q ${wt} feature`.quiet();
  if (sessionCwd) {
    const cwd = sessionCwd === "main" ? main : wt;
    const dir = join(home, ".pi/agent/sessions", slug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01T00-00-00-000Z_x.jsonl"),
      `{"type":"session","cwd":"${cwd}"}\n{"type":"message","message":{"role":"toolResult","content":"edited ${wt}/a.ts"}}\n`,
    );
  }
  // No origin, no gh: merge check reports "no"; PR "-".
  const out = await $`bash ${SCRIPT} ${main}`.env({ ...process.env, HOME: home, PATH: process.env.PATH! }).nothrow().quiet().text();
  const row = out.split("\n").find((l) => l.endsWith(`\t${wt}`))!;
  return row.split("\t");
}

test.each(["main", "wt"] as const)("a recent session launched in %s blocks the safe bucket", async (where) => {
  const cols = await audit(where);
  expect(cols[6]).not.toBe("-"); // LAST_CHAT
  expect(cols[7]).toBe("verify-recent-chat");
});

test("no sessions -> no last chat", async () => {
  const cols = await audit(null);
  expect(cols[6]).toBe("-");
  expect(cols[7]).not.toBe("verify-recent-chat");
});
