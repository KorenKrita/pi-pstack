import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAlwaysApplyRules,
  modeReminders,
  parseAlwaysApplyRule,
  parseSkillMeta,
  pathHints,
  pathHintKey,
} from "../extensions/pstack/rules";

describe("always-apply rules (R3b)", () => {
  test("parse: alwaysApply true returns body, false/absent returns null, malformed throws", () => {
    expect(parseAlwaysApplyRule("---\nalwaysApply: true\n---\nhello\n")).toBe("hello");
    expect(parseAlwaysApplyRule("---\nalwaysApply: false\n---\nhello")).toBeNull();
    expect(parseAlwaysApplyRule("---\ndescription: x\n---\nhello")).toBeNull();
    expect(parseAlwaysApplyRule('---\nalwaysApply: "true"\n---\nhello')).toBeNull();
    expect(() => parseAlwaysApplyRule("no frontmatter")).toThrow();
    expect(() => parseAlwaysApplyRule("---\nalwaysApply: true\nno close")).toThrow();
    expect(() => parseAlwaysApplyRule("---\na: [\n---\nx")).toThrow();
    expect(() => parseAlwaysApplyRule("---\n- a\n---\nx")).toThrow();
  });

  test("load: sorted, .mdc only, malformed skipped with warning, missing dir empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pstack-rules-"));
    writeFileSync(join(dir, "b.mdc"), "---\nalwaysApply: true\n---\nB body");
    writeFileSync(join(dir, "a.mdc"), "---\nalwaysApply: true\n---\nA body");
    writeFileSync(join(dir, "c.mdc"), "---\nalwaysApply: false\n---\nC");
    writeFileSync(join(dir, "bad.mdc"), "---\nalwaysApply: [\n---\nX");
    writeFileSync(join(dir, "note.md"), "---\nalwaysApply: true\n---\nnot a rule");
    const { rules, warnings } = loadAlwaysApplyRules(dir);
    expect(rules.map((r) => r.body)).toEqual(["A body", "B body"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.mdc");
    expect(loadAlwaysApplyRules(join(dir, "missing"))).toEqual({ rules: [], warnings: [] });
  });
});

describe("skill frontmatter (R3c/d)", () => {
  const skills = join(import.meta.dir, "../skills");
  const read = (n: string) => parseSkillMeta(readFileSync(join(skills, n, "SKILL.md"), "utf8"), n);

  test("poteto-mode is a mode skill with a reminder", () => {
    const m = read("pstack-poteto-mode");
    expect(m.mode).toBe(true);
    expect(m.disableModelInvocation).toBe(true);
    expect(m.reminder).toStartWith("New task?");
    expect(m.paths).toEqual([]);
  });

  test("typescript-best-practices has paths globs", () => {
    const m = read("pstack-typescript-best-practices");
    expect(m.mode).toBe(false);
    expect(m.paths).toEqual(["**/*.ts", "**/*.tsx"]);
  });

  test("ordinary skill: no mode, no reminder", () => {
    const m = read("pstack-how");
    expect(m).toMatchObject({ name: "pstack-how", mode: false, paths: [] });
    expect(m.reminder).toBeUndefined();
  });

  test("string paths, fallback name, reminders only from mode skills", () => {
    const a = parseSkillMeta("---\npaths: '*.md'\nreminder: hi\n---\n", "dir-a");
    expect(a).toEqual({ name: "dir-a", mode: false, paths: ["*.md"], reminder: "hi", disableModelInvocation: false });
    const b = parseSkillMeta("---\nname: b\nmode: true\nreminder: '  go  '\n---\n", "x");
    expect(modeReminders([a, b])).toEqual(["go"]);
  });
});

describe("path hints (R3d)", () => {
  const ts = parseSkillMeta('---\nname: typescript-best-practices\npaths: ["**/*.ts", "**/*.tsx"]\n---\n', "x");

  test("matches relative and absolute-in-cwd paths, including top-level files", () => {
    expect(pathHints([ts], "src/a/b.ts", "/repo", new Set()).map((h) => h.text)).toEqual([
      "Files matching **/*.ts were touched; skill typescript-best-practices applies — read it if you have not.",
    ]);
    expect(pathHints([ts], "/repo/index.tsx", "/repo", new Set())).toHaveLength(1);
    expect(pathHints([ts], "/repo/README.md", "/repo", new Set())).toEqual([]);
  });

  test("once per session via the shown set", () => {
    const shown = new Set([pathHintKey("typescript-best-practices", "**/*.ts")]);
    expect(pathHints([ts], "a.ts", "/repo", shown)).toEqual([]);
    expect(pathHints([ts], "a.tsx", "/repo", shown)).toHaveLength(1);
  });
});
