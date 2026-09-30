import { describe, expect, test } from "bun:test";
import { RULES, applyRules, isValidSkillName, normalizeSkillName, type Rule } from "../scripts/rules";

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
      'transcripts="$HOME/.cursor/projects/$slug/agent-transcripts"',
      "slug=$(printf '%s' \"$main_wt\" | sed 's#^/##; s#/#-#g')",
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
    expect(applyRules("skills/poteto-mode/scripts/worktree-audit.sh", text)).toBe('transcripts="$HOME/.pi/agent/sessions/$slug"');
    // Elsewhere only the generic fallback fires, keeping `$HOME` intact.
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
