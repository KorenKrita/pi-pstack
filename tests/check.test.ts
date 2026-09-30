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

describe("review regressions", () => {
  test("relative ./ and ../ Cursor paths are flagged; URLs are not", () => {
    const f = findCursorPaths("x.md", "`./.cursor/settings.json` `../.cursor/settings.json` https://cursor.com/docs/~/.cursor/rules/");
    expect(f.map((x) => x.message)).toEqual(["cursor path: .cursor/settings.json", "cursor path: .cursor/settings.json"]);
  });

  test("real upstream reference syntaxes are extracted", () => {
    const text = [
      "The **poteto-mode** skill routes.",
      "Use **arena** for design bakeoffs. Use **figure-it-out** whenever no playbook fits.",
      "per the **redesign-from-first-principles** and **fix-root-causes** principle skills.",
      "The **principle-a** and **principle-b** skills apply.",
      'say "reflect" or "/reflect".',
      "- **clean** — every feature passed. The **target** is usually code.",
    ].join("\n");
    expect(findSkillRefs(text).sort()).toEqual(
      [
        "arena",
        "figure-it-out",
        "poteto-mode",
        "principle-a",
        "principle-b",
        "principle-fix-root-causes",
        "principle-redesign-from-first-principles",
        "reflect",
      ].sort(),
    );
  });

  test("replacing a real reference with a missing skill is reported", () => {
    const known = new Set(["arena", "reflect", "poteto-mode"]);
    for (const text of ["The **missing-skill** skill.", "Use **missing-skill** for x.", '"/missing-skill"', "the **a** and **missing-skill** principle skills"]) {
      const r = checkSkillRefs("f", text, known).map((f) => f.message);
      expect(r.some((m) => m.includes("missing-skill"))).toBe(true);
    }
    expect(checkSkillRefs("f", "keep it in `/tmp` and see https://x.dev/missing-skill", known)).toEqual([]);
  });

  test("checkRepo scans every non-binary file, including .lock and .py", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-check-"));
    mkdirSync(join(root, "skills/a/scripts"), { recursive: true });
    writeFileSync(join(root, "skills/a/SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    writeFileSync(join(root, "skills/a/scripts/bun.lock"), '{"path": "~/.cursor/x"}');
    writeFileSync(join(root, "skills/a/scripts/tool.py"), 'P = "$HOME/.cursor/y"');
    writeFileSync(join(root, "skills/a/scripts/blob.bin"), Buffer.from([0, 1, 2, 0x7e, 0x2f, 0x2e]));
    expect(checkRepo(root).findings.map((f) => f.file).sort()).toEqual(["skills/a/scripts/bun.lock", "skills/a/scripts/tool.py"]);
  });
});
