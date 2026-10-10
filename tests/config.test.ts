import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  ROLES,
  NOT_CONFIGURED,
  applyBudget,
  applyBudgetToValue,
  formatModelRef,
  lookupFromRegistry,
  modelsRulePath,
  parseModelRef,
  parseModelsRule,
  pstackHome,
  readModelsRule,
  resolveTaskModel,
  serializeModelsRule,
  taskGate,
  validateConfigText,
  validateRoles,
  writeModelsRule,
  type ModelLookup,
  type RoleMap,
} from "../extensions/pstack/config";

const ALL: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FAKE: Record<string, { hasAuth: boolean; levels: ModelThinkingLevel[] }> = {
  "anthropic/opus": { hasAuth: true, levels: ALL },
  "openai/gpt": { hasAuth: true, levels: ["off", "minimal", "low", "medium", "high", "xhigh"] },
  "zai/glm": { hasAuth: true, levels: ["off", "minimal", "low", "medium", "high"] },
  "local/plain": { hasAuth: true, levels: ["off"] },
  "nokey/model": { hasAuth: false, levels: ALL },
};
const lookup: ModelLookup = {
  find: (p, id) => FAKE[`${p}/${id}`],
  availableIds: () => Object.keys(FAKE).filter((k) => FAKE[k]?.hasAuth),
};

function validRoles(value = "anthropic/opus:high"): RoleMap {
  return Object.fromEntries(ROLES.map((r) => [r.name, r.panel ? [value, "openai/gpt:xhigh", "auto"] : value]));
}

describe("pstackHome (R4)", () => {
  test("PSTACK_HOME overrides the default", () => {
    expect(pstackHome({ PSTACK_HOME: "/tmp/x" })).toBe("/tmp/x");
    expect(pstackHome({})).toBe(join(homedir(), ".pi", "pstack"));
    expect(modelsRulePath("/tmp/x")).toBe("/tmp/x/rules/pstack-models.mdc");
  });
});

describe("roles", () => {
  test("upstream role list and panels from setup-pstack step 5", () => {
    expect(ROLES).toHaveLength(17);
    expect(ROLES.filter((r) => r.panel).map((r) => r.name)).toEqual([
      "arena runners",
      "arena cross-judge pool",
      "architect runners",
      "interrogate reviewers",
    ]);
  });

  test("every role in the vendored setup skill's rule shape is known, in order", () => {
    const skill = readFileSync(join(import.meta.dir, "../skills/setup-pstack/SKILL.md"), "utf8");
    const block = /### 5\. Write the rule[\s\S]*?```\n([\s\S]*?)```/.exec(skill)?.[1] ?? "";
    const parsed = parseModelsRule(block);
    expect(parsed.unknownLines).toEqual([]);
    expect(Object.keys(parsed.roles)).toEqual(ROLES.map((r) => r.name));
  });
});

describe("parseModelRef", () => {
  test.each([
    ["inherit-parent", { kind: "alias", alias: "inherit-parent" }],
    ["auto", { kind: "alias", alias: "auto" }],
    ["anthropic/opus", { kind: "model", provider: "anthropic", id: "opus" }],
    ["anthropic/opus:max", { kind: "model", provider: "anthropic", id: "opus", level: "max" }],
    ["openrouter/meta/llama:off", { kind: "model", provider: "openrouter", id: "meta/llama", level: "off" }],
    ["ollama/qwen3:8b", { kind: "model", provider: "ollama", id: "qwen3:8b" }],
    ["ollama/qwen3:8b:low", { kind: "model", provider: "ollama", id: "qwen3:8b", level: "low" }],
  ])("%s", (raw, expected) => {
    expect(parseModelRef(raw)).toEqual(expected as never);
    expect(formatModelRef(parseModelRef(raw)!)).toBe(raw);
  });

  test.each(["claude-opus-5-5-max", "/x", "x/", "", "a b/c"])("rejects %p", (raw) => {
    expect(parseModelRef(raw)).toBeUndefined();
  });
});

describe("budget mapping", () => {
  test("large/medium/small map to xhigh/high/medium", () => {
    expect(applyBudgetToValue("anthropic/opus:max", "large", lookup)).toEqual({ ok: true, value: "anthropic/opus:xhigh" });
    expect(applyBudgetToValue("anthropic/opus", "medium", lookup)).toEqual({ ok: true, value: "anthropic/opus:high" });
    expect(applyBudgetToValue("anthropic/opus:low", "small", lookup)).toEqual({ ok: true, value: "anthropic/opus:medium" });
  });

  test("unlimited keeps the entry level, defaulting to max, clamped down", () => {
    expect(applyBudgetToValue("anthropic/opus:low", "unlimited", lookup)).toEqual({ ok: true, value: "anthropic/opus:low" });
    expect(applyBudgetToValue("anthropic/opus", "unlimited", lookup)).toEqual({ ok: true, value: "anthropic/opus:max" });
    expect(applyBudgetToValue("openai/gpt", "unlimited", lookup)).toEqual({ ok: true, value: "openai/gpt:xhigh" });
    expect(applyBudgetToValue("zai/glm", "large", lookup)).toEqual({ ok: true, value: "zai/glm:high" });
  });

  test("aliases unchanged; non-reasoning models get no level", () => {
    expect(applyBudgetToValue("auto", "small", lookup)).toEqual({ ok: true, value: "auto" });
    expect(applyBudgetToValue("local/plain:off", "large", lookup)).toEqual({ ok: true, value: "local/plain" });
  });

  test("no supported level at or below target → needs a choice", () => {
    const minOnly: ModelLookup = { find: () => ({ hasAuth: true, levels: ["off", "high", "max"] }), availableIds: () => [] };
    expect(applyBudgetToValue("x/y", "small", minOnly)).toEqual({ ok: true, value: "x/y:off" });
    const noOff: ModelLookup = { find: () => ({ hasAuth: true, levels: ["high", "max"] }), availableIds: () => [] };
    expect(applyBudgetToValue("x/y", "small", noOff).ok).toBe(false);
  });

  test("explicit :off on a reasoning model is kept under any budget", () => {
    expect(applyBudgetToValue("anthropic/opus:off", "unlimited", lookup)).toEqual({ ok: true, value: "anthropic/opus:off" });
    expect(applyBudgetToValue("anthropic/opus:off", "small", lookup)).toEqual({ ok: true, value: "anthropic/opus:off" });
  });

  test("applyBudget maps panels and marks unmappable roles", () => {
    const { roles, needsChoice } = applyBudget(
      { "bug-fix": "zai/glm", "arena runners": ["anthropic/opus", "inherit-parent"], hillclimb: "claude-opus-5-5-max", "how explorer": "gone/x" },
      "large",
      lookup,
    );
    expect(roles["bug-fix"]).toBe("zai/glm:high");
    expect(roles["arena runners"]).toEqual(["anthropic/opus:xhigh", "inherit-parent"]);
    expect(roles.hillclimb).toBe("claude-opus-5-5-max");
    expect(needsChoice.map((n) => n.role)).toEqual(["hillclimb", "how explorer"]);
  });
});

describe("validation", () => {
  test("a full valid map passes", () => {
    expect(validateRoles(validRoles(), lookup)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("missing role, empty panel, scalar panel, unknown model, no creds, bad level, extra role", () => {
    const roles = validRoles();
    delete roles["bug-fix"];
    roles["arena runners"] = [];
    roles["architect runners"] = "anthropic/opus";
    roles.hillclimb = "nope/none";
    roles["perf-issue"] = "nokey/model";
    roles["swarm workers"] = "zai/glm:max";
    roles["how critics"] = "auto";
    const report = validateRoles(roles, lookup);
    expect(report.ok).toBe(false);
    const all = report.errors.join("\n");
    expect(all).toContain('missing role "bug-fix"');
    expect(all).toContain('panel role "arena runners" is empty');
    expect(all).toContain('role "architect runners" must be a list');
    expect(all).toContain('Unknown model "nope/none"');
    expect(all).toContain('"nokey/model" has no configured credentials');
    expect(all).toContain("Supported levels: off, minimal, low, medium, high.");
    expect(report.warnings).toEqual(['unknown role "how critics"']);
  });

  test("frontmatter uses rule loader semantics for malformed, duplicate and commented YAML", () => {
    const good = serializeModelsRule(validRoles(), "medium");
    for (const text of [good.replace("alwaysApply: true", "alwaysApply: ["), good.replace("alwaysApply: true", "alwaysApply: true\nalwaysApply: false")]) {
      expect(validateConfigText(text, lookup).ok).toBe(false);
    }
    const commented = good.replace("alwaysApply: true", "alwaysApply: true # enabled");
    expect(validateConfigText(commented, lookup).ok).toBe(true);
  });

  test("text: missing file, unknown lines, duplicates, alwaysApply", () => {
    expect(validateConfigText(undefined, lookup).errors).toEqual(["config file does not exist"]);
    const text = serializeModelsRule(validRoles(), "medium") + "how critics: auto\nbug-fix: auto\n";
    const report = validateConfigText(text, lookup);
    expect(report.errors).toEqual(['role "bug-fix" appears more than once']);
    expect(report.warnings).toEqual(['unknown line "how critics: auto"']);
    const noApply = validateConfigText(serializeModelsRule(validRoles(), "medium").replace("alwaysApply: true", "alwaysApply: false"), lookup);
    expect(noApply.errors[0]).toBe("frontmatter must set alwaysApply: true");
  });
});

describe(".mdc round trip", () => {
  test("serialize → parse preserves roles and budget in upstream shape", () => {
    const roles = validRoles("zai/glm:high");
    const text = serializeModelsRule(roles, "medium");
    expect(text.startsWith("---\ndescription: pstack per-role model choices (overrides skill defaults)\nalwaysApply: true\n---\n")).toBe(true);
    expect(text).toContain("# budget: medium (high)\n");
    expect(text).toContain("arena runners: zai/glm:high, openai/gpt:xhigh, auto\n");
    const parsed = parseModelsRule(text);
    expect(parsed.roles).toEqual(roles);
    expect(parsed.budget).toEqual({ name: "medium", level: "high" });
    expect(parsed.alwaysApply).toBe(true);
    expect(serializeModelsRule(parsed.roles, "medium")).toBe(text);
  });

  test("re-run keeps prior choices: parse existing, change one role, rewrite", () => {
    const first = serializeModelsRule(validRoles(), "large");
    const prior = parseModelsRule(first);
    const next = { ...prior.roles, "bug-fix": "inherit-parent" };
    const parsed = parseModelsRule(serializeModelsRule(next, "large"));
    expect(parsed.roles["bug-fix"]).toBe("inherit-parent");
    expect(parsed.roles.hillclimb).toBe(prior.roles.hillclimb as string);
    expect(parsed.roles["interrogate reviewers"]).toEqual(prior.roles["interrogate reviewers"] as string[]);
  });

  test("atomic write under a temp PSTACK_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-home-"));
    expect(readModelsRule(home)).toBeUndefined();
    const path = writeModelsRule(home, "a");
    writeModelsRule(home, "b");
    expect(path).toBe(modelsRulePath(home));
    expect(readModelsRule(home)).toBe("b");
    expect(readdirSync(join(home, "rules"))).toEqual(["pstack-models.mdc"]);
  });
});

describe("Task gate (R7)", () => {
  const good = serializeModelsRule(validRoles(), "medium");

  test("(i) missing or invalid config → setup error with report", () => {
    const missing = taskGate(undefined, undefined, lookup);
    expect(missing.stage).toBe("config");
    expect(missing.text.startsWith(NOT_CONFIGURED)).toBe(true);
    expect(missing.text).toContain("config file does not exist");
    const bad = taskGate(good.replace(/^bug-fix: .*\n/m, ""), undefined, lookup);
    expect(bad.stage).toBe("config");
    expect(bad.text).toContain('missing role "bug-fix"');
  });

  test("(ii) unknown model lists available ids; bad level lists supported levels", () => {
    const unknown = taskGate(good, "claude-opus-5-5-max", lookup);
    expect(unknown.stage).toBe("model");
    expect(unknown.text).toContain("is not a Pi model value");
    expect(unknown.text).toContain("Available models (configured credentials, not a liveness check): anthropic/opus");
    const unknown2 = taskGate(good, "anthropic/claude-opus-5-5", lookup);
    expect(unknown2.text).toContain("anthropic/opus, openai/gpt, zai/glm, local/plain");
    expect(unknown2.text).not.toContain("nokey/model");
    const level = taskGate(good, "zai/glm:xhigh", lookup);
    expect(level.stage).toBe("model");
    expect(level.text).toContain("Supported levels: off, minimal, low, medium, high.");
  });

  test("(iii) valid → ok, with resolved model", () => {
    for (const m of [undefined, "", "inherit-parent", "auto"]) {
      expect(taskGate(good, m, lookup)).toEqual({ stage: "ok", text: "ok", model: { kind: "parent" } });
    }
    expect(resolveTaskModel("openai/gpt:high", lookup)).toEqual({
      ok: true,
      model: { kind: "model", provider: "openai", id: "gpt", level: "high" },
    });
  });
});

describe("lookupFromRegistry", () => {
  test("adapts a ModelRegistry-shaped object using pi-ai getSupportedThinkingLevels", () => {
    const models = [
      { provider: "a", id: "r", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      { provider: "b", id: "n", reasoning: false },
    ] as never[];
    const l = lookupFromRegistry({
      find: (p, id) => models.find((m: { provider: string; id: string }) => m.provider === p && m.id === id),
      hasConfiguredAuth: (m) => (m as { provider: string }).provider === "a",
      getAvailable: () => [models[0]!],
    });
    expect(l.find("a", "r")).toEqual({ hasAuth: true, levels: ["off", "minimal", "low", "medium", "high", "xhigh"] });
    expect(l.find("b", "n")).toEqual({ hasAuth: false, levels: ["off"] });
    expect(l.find("c", "x")).toBeUndefined();
    expect(l.availableIds()).toEqual(["a/r"]);
  });
});


describe("generated setup-pstack text (R5)", () => {
  const text = readFileSync(join(import.meta.dir, "../skills/setup-pstack/SKILL.md"), "utf8");
  const shape = text.match(/```\n(---\n[\s\S]*?)```/)![1]!;

  test("shape lists exactly ROLES in order and matches serializeModelsRule's header", () => {
    const parsed = parseModelsRule(shape);
    expect(Object.keys(parsed.roles)).toEqual(ROLES.map((r) => r.name));
    const header = serializeModelsRule({}, "unlimited").trimEnd();
    expect(shape.startsWith(header)).toBe(true);
  });

  test("arena, swarm, interrogate read config through pstack_config, not the default home", () => {
    for (const name of ["arena", "swarm", "interrogate"]) {
      const skill = readFileSync(join(import.meta.dir, `../skills/pstack-${name}/SKILL.md`), "utf8");
      expect(skill).toContain('`pstack_config` with `action: "read"`');
      expect(skill).not.toContain("~/.pi/pstack/rules/pstack-models.mdc");
      expect(skill).not.toMatch(/claude-opus-5-5-max|gpt-5\.6-sol-max|grok-4\.7-xhigh-fast/);
    }
  });

  test("no upstream Cursor slugs as defaults; writes go through pstack_config", () => {
    expect(text).not.toMatch(/claude-opus|gpt-5\.6|grok-4/);
    expect(text).toContain('`pstack_config` tool with `action: "write"`');
    expect(text).toContain("$PSTACK_HOME/rules/pstack-models.mdc");
    expect(text).toContain("needing a choice");
  });
});
