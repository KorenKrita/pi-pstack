import { describe, expect, test } from "bun:test";
import { RULES, applyRules, isValidSkillName, namespaceSkills, normalizeSkillName, pstackName, type Rule } from "../scripts/rules";

describe("applyRules", () => {
  test("specific paths win over the generic fallback", () => {
    const text = "See `~/.cursor/rules/pstack-models.mdc`, `~/.cursor/skills/x/`, `~/.cursor/other/`.";
    expect(applyRules("skills/a/SKILL.md", text)).toBe(
      "See `~/.pi/pstack/rules/pstack-models.mdc`, `~/.pi/agent/skills/x/`, `~/.pi/pstack/other/`.",
    );
  });

  test("workspace vs user-level skills dirs", () => {
    const text = "`.cursor/skills/verify-app/` and `~/.cursor/skills/*-mode/SKILL.md`";
    expect(applyRules("skills/a/SKILL.md", text)).toBe("`.pi/skills/verify-app/` and `~/.pi/agent/skills/*-mode/SKILL.md`");
  });

  test("transcript phrases map to the Pi session dir", () => {
    const text = "the active workspace's `agent-transcripts/` directory. Do not glob across `~/.cursor/projects/*/`.";
    expect(applyRules("skills/a/SKILL.md", text)).toBe(
      "the active workspace's Pi session directory `~/.pi/agent/sessions/<slug>/`. Do not glob across `~/.pi/agent/sessions/*/`.",
    );
  });

  test("idempotent: applying twice equals applying once", () => {
    const text = [
      "`~/.cursor/rules/pstack-models.mdc`",
      "under `agent-transcripts/`",
      "ls <agent-transcripts>/*.jsonl",
      "plugin-installed paths under `~/.cursor/plugins/`",
      "`.cursor/skills/x`",
    ].join("\n");
    const path = "skills/poteto-mode/scripts/worktree-audit.sh";
    const once = applyRules(path, text);
    expect(applyRules(path, once)).toBe(once);
    expect(once).not.toContain(".cursor");
  });

  test("URLs are never rewritten", () => {
    const text = "https://github.com/cursor/plugins/blob/main/.cursor/skills/x and https://cursor.com/docs/~/.cursor/rules/";
    expect(applyRules("skills/a/SKILL.md", text)).toBe(text);
  });

  test("file-scoped rules only apply to matching paths", () => {
    const text = 'transcripts="$HOME/.cursor/projects/$slug/agent-transcripts"';
    // Outside worktree-audit.sh only the generic fallback fires, keeping `$HOME` intact.
    expect(applyRules("skills/other/x.sh", text)).toBe('transcripts="$HOME/.pi/pstack/projects/$slug/agent-transcripts"');
  });

  test("string rules are literal and record hit counts", () => {
    const rules: Rule[] = [{ id: "r", description: "", find: "a.b", replace: "$1$&" }];
    const hits: Record<string, number> = {};
    expect(applyRules("x", "a.b axb a.b", rules, hits)).toBe("$1$& axb $1$&");
    expect(hits.r).toBe(2);
  });

  test("rule ids are unique", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
});

describe("skill names", () => {
  test("normalizes display names", () => {
    expect(normalizeSkillName("Poteto Mode")).toBe("poteto-mode");
    expect(normalizeSkillName("  Make  Bot--UI! ")).toBe("make-bot-ui");
    expect(normalizeSkillName("x".repeat(70))).toHaveLength(64);
    expect(normalizeSkillName(`${"a".repeat(63)}-b`)).toBe("a".repeat(63));
  });

  test("validates Pi rules", () => {
    for (const ok of ["poteto-mode", "a", "principle-x-1"]) expect(isValidSkillName(ok)).toBe(true);
    for (const bad of ["Poteto Mode", "-a", "a-", "a--b", "", "a_b", "x".repeat(65)]) expect(isValidSkillName(bad)).toBe(false);
  });
});

describe("review regressions", () => {
  test("relative workspace skill paths are rewritten and pass the checker", async () => {
    const { findCursorPaths } = await import("../scripts/check");
    const out = applyRules("skills/a/SKILL.md", "`./.cursor/skills/verify-app/SKILL.md` `../.cursor/skills/x/` `$HOME/.cursor/skills/y/`");
    expect(out).toBe("`./.pi/skills/verify-app/SKILL.md` `../.pi/skills/x/` `$HOME/.pi/agent/skills/y/`");
    expect(findCursorPaths("skills/a/SKILL.md", out)).toEqual([]);
  });
});

describe("skill namespace", () => {
  const names = new Set(["how", "why", "arena", "poteto-mode", "principle-prove-it-works", "setup-pstack", "create-skill"]);
  test("pstackName prefixes unless the name already says pstack", () => {
    expect(pstackName("how")).toBe("pstack-how");
    expect(pstackName("setup-pstack")).toBe("setup-pstack");
  });
  test("rewrites skill references, keeps slash commands, prose words and URLs", () => {
    const text = [
      "Run the **how** skill, then `why` and `arena`'s Phase A, /how or `/arena`.",
      "Per [Prove It Works](../principle-prove-it-works/SKILL.md) and [arena](../../arena/SKILL.md), **setup-pstack**.",
      "Use `/skill:poteto-mode` or /skill:how; the **Feature** playbook; how explorer; `howto`.",
      "Named `benchmark`, `candidate`, or `arena` in any directory; such as `pstack` or `poteto-mode`, as the scope.",
      "if the user's `why` question; users often phrase `why` questions. See https://x.dev/skills/how/x and pstack/skills/how/SKILL.md.",
    ].join("\n");
    const hits: Record<string, number> = {};
    expect(namespaceSkills(text, names, hits)).toBe(
      [
        "Run the **pstack-how** skill, then `pstack-why` and `pstack-arena`'s Phase A, /how or `/arena`.",
        "Per [Prove It Works](../pstack-principle-prove-it-works/SKILL.md) and [arena](../../pstack-arena/SKILL.md), **setup-pstack**.",
        "Use `/skill:pstack-poteto-mode` or /skill:pstack-how; the **Feature** playbook; how explorer; `howto`.",
        "Named `benchmark`, `candidate`, or `arena` in any directory; such as `pstack` or `poteto-mode`, as the scope.",
        "if the user's `why` question; users often phrase `why` questions. See https://x.dev/skills/how/x and pstack/skills/how/SKILL.md.",
      ].join("\n"),
    );
    expect(hits["skill-namespace"]).toBe(7);
  });
  test("plain-prose skill references and the principle-* family (real upstream sentences)", () => {
    const text = [
      "- `decisions.tsv` is the trail via the show-me-your-work skill.",
      "Any one-way door goes through the arena skill before the pilot.",
      "Navigate to a leaf `principle-*` skill whenever you apply that principle.",
      "how explorer: x; the how and why of it; a skill like arena.",
    ].join("\n");
    expect(namespaceSkills(text, new Set(["show-me-your-work", "arena", "how", "why", "principle-prove-it-works"]))).toBe(
      [
        "- `decisions.tsv` is the trail via the pstack-show-me-your-work skill.",
        "Any one-way door goes through the pstack-arena skill before the pilot.",
        "Navigate to a leaf `pstack-principle-*` skill whenever you apply that principle.",
        "how explorer: x; the how and why of it; a skill like arena.",
      ].join("\n"),
    );
  });
});
