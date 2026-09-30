import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepo, checkSkillFrontmatter, checkSkillRefs, findCursorPaths, findSkillRefs } from "../scripts/check";

describe("findCursorPaths", () => {
  test("flags home and bare workspace paths", () => {
    const f = findCursorPaths("skills/a/SKILL.md", "`~/.cursor/x` `$HOME/.cursor/y` `.cursor/settings.json`");
    expect(f.map((x) => x.message)).toEqual([
      "cursor path: ~/.cursor/x",
      "cursor path: $HOME/.cursor/y",
      "cursor path: .cursor/settings.json",
    ]);
  });

  test("ignores Pi paths, identifiers, and allowlisted entries", () => {
    expect(findCursorPaths("skills/a/SKILL.md", "`.pi/skills/` endCursor foo.cursor/bar cursor-team-kit")).toEqual([]);
    expect(findCursorPaths("skills/poteto-mode/playbooks/worktree-cleanup.md", "at `.cursor/worktrees/myrepo/x`")).toEqual([]);
    expect(findCursorPaths("skills/other.md", "at `.cursor/worktrees/myrepo/x`")).toHaveLength(1);
  });
});

describe("checkSkillFrontmatter", () => {
  test("valid", () => {
    expect(checkSkillFrontmatter("f", "why", "---\nname: why\ndescription: d\n---\n")).toEqual([]);
  });
  test("invalid name, mismatch, missing description, no frontmatter", () => {
    expect(checkSkillFrontmatter("f", "poteto-mode", "---\nname: Poteto Mode\ndescription: d\n---\n")[0]!.message).toContain("invalid");
    expect(checkSkillFrontmatter("f", "b", "---\nname: a\ndescription: d\n---\n")[0]!.message).toContain("!= directory");
    expect(checkSkillFrontmatter("f", "a", "---\nname: a\n---\n")[0]!.message).toBe("missing description");
    expect(checkSkillFrontmatter("f", "a", "# a")[0]!.message).toBe("missing frontmatter");
  });
});

describe("skill refs", () => {
  test("extracts bold, principle, and slash refs", () => {
    const refs = findSkillRefs("the **how** skill, **principle-x**, the **y** principle, run `/deslop` or /why. See `/tmp/foo`.");
    expect(refs.sort()).toEqual(["deslop", "how", "principle-x", "principle-y", "why"].sort());
  });
  test("resolves against vendored + external allowlist", () => {
    const known = new Set(["how"]);
    expect(checkSkillRefs("f", "the **how** skill and the **create-skill** skill, /loop", known)).toEqual([]);
    expect(checkSkillRefs("f", "the **nope** skill", known)).toEqual([{ file: "f", message: "unresolved skill reference: nope" }]);
  });
});

test("checkRepo on a fixture tree", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-check-"));
  mkdirSync(join(root, "skills/good"), { recursive: true });
  mkdirSync(join(root, "skills/bad"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "skills/good/SKILL.md"), "---\nname: good\ndescription: d\n---\nUse the **bad** skill.\n");
  writeFileSync(join(root, "skills/bad/SKILL.md"), "---\nname: Bad\n---\nSee `~/.cursor/rules/x` and the **ghost** skill.\n");
  writeFileSync(join(root, "agents/a.md"), "---\nname: a\n---\n.cursor/settings.json\n");
  const { findings, skills } = checkRepo(root);
  expect(skills).toBe(2);
  expect(findings.map((f) => `${f.file}: ${f.message}`).sort()).toEqual(
    [
      "agents/a.md: cursor path: .cursor/settings.json",
      "skills/bad/SKILL.md: cursor path: ~/.cursor/rules/x",
      'skills/bad/SKILL.md: invalid skill name: "Bad"',
      "skills/bad/SKILL.md: missing description",
      "skills/bad/SKILL.md: unresolved skill reference: ghost",
    ].sort(),
  );
});
