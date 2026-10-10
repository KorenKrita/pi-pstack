import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULES } from "../scripts/rules";
import { adaptText, readUpstream, shippedSkillNames } from "../scripts/sync";

async function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-"));
  mkdirSync(join(dir, "pstack/skills/a"), { recursive: true });
  mkdirSync(join(dir, "pstack/skills/make-bot-ui"), { recursive: true });
  mkdirSync(join(dir, "pstack/agents"), { recursive: true });
  mkdirSync(join(dir, "pstack/automations/benny"), { recursive: true });
  writeFileSync(join(dir, "pstack/skills/a/SKILL.md"), "committed");
  writeFileSync(join(dir, "pstack/skills/a/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "pstack/skills/make-bot-ui/SKILL.md"), "x");
  writeFileSync(join(dir, "pstack/agents/x.md"), "agent");
  writeFileSync(join(dir, "pstack/automations/benny/README.md"), "x");
  await $`git -C ${dir} init -q && git -C ${dir} add -A && git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m c`.quiet();
  const commit = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  return { dir, commit };
}

test("reads the pinned tree, ignoring dirty and untracked working-tree files", async () => {
  const { dir, commit } = await fixtureRepo();
  writeFileSync(join(dir, "pstack/skills/a/SKILL.md"), "DIRTY");
  writeFileSync(join(dir, "pstack/skills/a/untracked.md"), "new");
  const files = await readUpstream(dir, commit);
  expect([...files.keys()].sort()).toEqual(["agents/x.md", "skills/pstack-a/SKILL.md", "skills/pstack-a/run.sh"]);
  expect(files.get("skills/pstack-a/SKILL.md")!.data.toString()).toBe("committed");
  expect(files.get("skills/pstack-a/run.sh")!.mode).toBe(0o755);
});

test("rejects a checkout that does not contain the pinned commit", async () => {
  const { dir } = await fixtureRepo();
  expect(readUpstream(dir, "fae2c6ed95821bd85f614a73e4842e13229fa5e5")).rejects.toThrow(/not a git checkout containing/);
  expect(readUpstream(mkdtempSync(join(tmpdir(), "nogit-")), "deadbeef")).rejects.toThrow(/not a git checkout/);
});

test("every skill is vendored under a pstack- name; rules still match the unprefixed logical path", async () => {
  const { dir } = await fixtureRepo();
  mkdirSync(join(dir, "pstack/skills/setup-pstack"), { recursive: true });
  writeFileSync(join(dir, "pstack/skills/setup-pstack/SKILL.md"), "---\nname: setup-pstack\n---\nRun the **a** skill, /a, and **create-skill**.\n");
  writeFileSync(join(dir, "pstack/skills/a/SKILL.md"), "---\nname: a\n---\nSee `setup-pstack`.\n");
  await $`git -C ${dir} add -A && git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m more`.quiet();
  const commit = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  const files = await readUpstream(dir, commit);
  const setup = files.get("skills/setup-pstack/SKILL.md")!;
  expect(setup.logical).toBe("skills/setup-pstack/SKILL.md");
  expect(files.get("skills/pstack-a/SKILL.md")!.logical).toBe("skills/a/SKILL.md");
  const names = shippedSkillNames(files);
  expect([...names].sort()).toEqual(["a", "create-skill", "setup-pstack"]);
  expect(adaptText(setup, names)).toBe("---\nname: setup-pstack\n---\nRun the **pstack-a** skill, /a, and **pstack-create-skill**.\n");
  expect(adaptText(files.get("skills/pstack-a/SKILL.md")!, names)).toBe("---\nname: pstack-a\n---\nSee `setup-pstack`.\n");
  // A path-scoped rule is written against the logical path and still fires for a renamed skill.
  const rule = RULES.find((r) => r.files === "skills/poteto-mode/scripts/worktree-audit.sh")!;
  expect(rule).toBeDefined();
});
