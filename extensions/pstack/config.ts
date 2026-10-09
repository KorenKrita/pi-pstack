// Pure pstack configuration logic: config paths, the per-role model rule (.mdc) in upstream shape,
// validation, budget mapping, model-string parsing, and the Task gate. No Pi runtime wiring here;
// the model registry is injected through `ModelLookup` so tests can fake it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseRuleFrontmatter } from "./rules";

// ---------- R4: single config path ----------

export function pstackHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PSTACK_HOME || join(homedir(), ".pi", "pstack");
}

export function modelsRulePath(home: string): string {
  return join(home, "rules", "pstack-models.mdc");
}

/** Per-workspace agent store (Cursor's ~/.cursor/projects/<slug>/): orchestrate/, docs/. Slug as Pi's session dirs. */
export function agentStoreDir(home: string, cwd: string): string {
  return join(home, "projects", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

export function readModelsRule(home: string): string | undefined {
  try {
    return readFileSync(modelsRulePath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeModelsRule(home: string, text: string): string {
  const path = modelsRulePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return path;
}

// ---------- Roles (skills/setup-pstack/SKILL.md step 5) ----------

export const ROLES = [
  { name: "feature, refactoring", panel: false },
  { name: "bug-fix", panel: false },
  { name: "perf-issue", panel: false },
  { name: "hillclimb", panel: false },
  { name: "judgment and prose", panel: false },
  { name: "hardest tasks", panel: false },
  { name: "how explorer", panel: false },
  { name: "how explainer", panel: false },
  { name: "why investigators", panel: false },
  { name: "why synthesizer", panel: false },
  { name: "reflect tooling", panel: false },
  { name: "reflect judgment, divergent, synthesizer", panel: false },
  { name: "arena runners", panel: true },
  { name: "arena cross-judge pool", panel: true },
  { name: "swarm workers", panel: false },
  { name: "architect runners", panel: true },
  { name: "interrogate reviewers", panel: true },
] as const;

export type RoleValue = string | string[];
export type RoleMap = Record<string, RoleValue>;

const ROLE_BY_NAME = new Map<string, (typeof ROLES)[number]>(ROLES.map((r) => [r.name, r]));

// ---------- Budget (R5) ----------

export const BUDGETS = {
  unlimited: { label: "unlimited — keep max", target: "max" },
  large: { label: "large — xhigh reasoning", target: "xhigh" },
  medium: { label: "medium — high reasoning", target: "high" },
  small: { label: "small — medium reasoning", target: "medium" },
} as const satisfies Record<string, { label: string; target: ModelThinkingLevel }>;

export type BudgetName = keyof typeof BUDGETS;

export function isBudgetName(value: string): value is BudgetName {
  return Object.hasOwn(BUDGETS, value);
}

// Ascending ladder, same order as pi-ai's EXTENDED_THINKING_LEVELS.
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

// ---------- Model strings ----------

export const ALIASES = ["inherit-parent", "auto"] as const;

export type ModelRef =
  | { kind: "alias"; alias: (typeof ALIASES)[number] }
  | { kind: "model"; provider: string; id: string; level?: ModelThinkingLevel };

/** Parse `inherit-parent` | `auto` | `provider/id[:level]`. Like Pi, a trailing `:x` is a level only when x is a valid level. */
export function parseModelRef(raw: string): ModelRef | undefined {
  const value = raw.trim();
  if (value === "inherit-parent" || value === "auto") return { kind: "alias", alias: value };
  let base = value;
  let level: ModelThinkingLevel | undefined;
  const colon = value.lastIndexOf(":");
  if (colon !== -1) {
    const suffix = value.slice(colon + 1);
    if (isThinkingLevel(suffix)) {
      level = suffix;
      base = value.slice(0, colon);
    }
  }
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1 || /\s/.test(base)) return undefined;
  const ref: ModelRef = { kind: "model", provider: base.slice(0, slash), id: base.slice(slash + 1) };
  if (level) ref.level = level;
  return ref;
}

export function formatModelRef(ref: ModelRef): string {
  if (ref.kind === "alias") return ref.alias;
  return `${ref.provider}/${ref.id}${ref.level ? `:${ref.level}` : ""}`;
}

/** What validation needs from Pi's model registry. Build the real one with `lookupFromRegistry`. */
export interface ModelLookup {
  find(provider: string, id: string): { hasAuth: boolean; levels: readonly ModelThinkingLevel[] } | undefined;
  /** `provider/id` of every model with configured credentials (not a liveness check). */
  availableIds(): string[];
}

export function lookupFromRegistry(registry: {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
  getAvailable(): Model<Api>[];
}): ModelLookup {
  return {
    find(provider, id) {
      const model = registry.find(provider, id);
      if (!model) return undefined;
      return { hasAuth: registry.hasConfiguredAuth(model), levels: getSupportedThinkingLevels(model) };
    },
    availableIds: () => registry.getAvailable().map((m) => `${m.provider}/${m.id}`),
  };
}

function availableText(lookup: ModelLookup): string {
  const ids = lookup.availableIds();
  return `Available models (configured credentials, not a liveness check): ${ids.length ? ids.join(", ") : "(none)"}.`;
}

export type CheckedRef = { ok: true; ref: ModelRef } | { ok: false; error: string };

/** Validate one value: an alias, or a known model with credentials and a supported level. */
export function checkModelValue(raw: string, lookup: ModelLookup): CheckedRef {
  const ref = parseModelRef(raw);
  if (!ref) {
    return { ok: false, error: `"${raw}" is not a Pi model value (expected provider/id[:level], inherit-parent, or auto). ${availableText(lookup)}` };
  }
  if (ref.kind === "alias") return { ok: true, ref };
  const name = `${ref.provider}/${ref.id}`;
  const found = lookup.find(ref.provider, ref.id);
  if (!found) return { ok: false, error: `Unknown model "${name}". ${availableText(lookup)}` };
  if (!found.hasAuth) return { ok: false, error: `Model "${name}" has no configured credentials. ${availableText(lookup)}` };
  if (ref.level && !found.levels.includes(ref.level)) {
    return {
      ok: false,
      error: `Model "${name}" does not support thinking level "${ref.level}". Supported levels: ${found.levels.join(", ")}.`,
    };
  }
  return { ok: true, ref };
}

/**
 * Apply a budget to one value. Aliases are unchanged. A model gets the highest supported level
 * at or below the target (`unlimited` targets the entry's own level, default `max`); `off` only
 * counts for models that support nothing else, which are written without a level.
 */
export function applyBudgetToValue(
  raw: string,
  budget: BudgetName,
  lookup: ModelLookup,
): { ok: true; value: string } | { ok: false; reason: string } {
  const ref = parseModelRef(raw);
  if (!ref) return { ok: false, reason: `"${raw}" is not a Pi model value` };
  if (ref.kind === "alias") return { ok: true, value: ref.alias };
  const found = lookup.find(ref.provider, ref.id);
  const name = `${ref.provider}/${ref.id}`;
  if (!found) return { ok: false, reason: `unknown model "${name}"` };
  if (!found.hasAuth) return { ok: false, reason: `model "${name}" has no configured credentials` };
  const reasoning = found.levels.filter((l) => l !== "off");
  if (reasoning.length === 0) return { ok: true, value: name };
  if (ref.level === "off" && found.levels.includes("off")) return { ok: true, value: `${name}:off` };
  const target: ModelThinkingLevel = budget === "unlimited" ? (ref.level ?? "max") : BUDGETS[budget].target;
  const targetIndex = THINKING_LEVELS.indexOf(target);
  const best = [...found.levels].reverse().find((l) => THINKING_LEVELS.indexOf(l) <= targetIndex);
  if (!best) return { ok: false, reason: `model "${name}" supports no thinking level at or below "${target}"` };
  return { ok: true, value: `${name}:${best}` };
}

/** Apply a budget to every role. Roles where any entry cannot be mapped are left as-is and listed in `needsChoice`. */
export function applyBudget(
  roles: RoleMap,
  budget: BudgetName,
  lookup: ModelLookup,
): { roles: RoleMap; needsChoice: { role: string; reason: string }[] } {
  const out: RoleMap = {};
  const needsChoice: { role: string; reason: string }[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const entries = Array.isArray(value) ? value : [value];
    const mapped: string[] = [];
    let reason: string | undefined;
    for (const entry of entries) {
      const result = applyBudgetToValue(entry, budget, lookup);
      if (result.ok) mapped.push(result.value);
      else reason ??= result.reason;
    }
    if (reason) {
      out[role] = value;
      needsChoice.push({ role, reason });
    } else {
      out[role] = Array.isArray(value) ? mapped : (mapped[0] as string);
    }
  }
  return { roles: out, needsChoice };
}

// ---------- .mdc parse / serialize (upstream shape) ----------

export interface ParsedConfig {
  alwaysApply: boolean;
  budget?: { name: string; level: string };
  roles: RoleMap;
  /** Lines that are neither comments, a known role, nor blank — e.g. retired roles like `how critics`. */
  unknownLines: string[];
  duplicateRoles: string[];
  frontmatterError?: string;
}

export function parseModelsRule(text: string): ParsedConfig {
  const normalized = text.replace(/\r\n?/g, "\n");
  let body = normalized;
  let alwaysApply = false;
  let frontmatterError: string | undefined;
  try {
    const parsed = parseRuleFrontmatter(normalized);
    alwaysApply = parsed.frontmatter.alwaysApply === true;
    body = parsed.body;
  } catch (error) {
    frontmatterError = (error as Error).message;
    // Do not parse a malformed header as role lines; validation reports the YAML error.
    body = "";
  }
  const parsed: ParsedConfig = { alwaysApply, roles: {}, unknownLines: [], duplicateRoles: [] };
  if (frontmatterError) parsed.frontmatterError = frontmatterError;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const budget = /^#\s*budget:\s*(\S+)\s*\(([^)]*)\)\s*$/.exec(line);
      if (budget) parsed.budget = { name: budget[1] as string, level: (budget[2] as string).trim() };
      continue;
    }
    const colon = line.indexOf(":");
    const role = colon === -1 ? undefined : ROLE_BY_NAME.get(line.slice(0, colon).trim());
    if (!role) {
      parsed.unknownLines.push(line);
      continue;
    }
    if (Object.hasOwn(parsed.roles, role.name)) parsed.duplicateRoles.push(role.name);
    const value = line.slice(colon + 1).trim();
    parsed.roles[role.name] = role.panel
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : value;
  }
  return parsed;
}

export function serializeModelsRule(roles: RoleMap, budget: BudgetName): string {
  const lines = [
    "---",
    "description: pstack per-role model choices (overrides skill defaults)",
    "alwaysApply: true",
    "---",
    "# pstack model configuration. One line per role. Every role is required; re-run /setup-pstack to change it.",
    "# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.",
    `# budget: ${budget} (${BUDGETS[budget].target})`,
  ];
  for (const role of ROLES) {
    const value = roles[role.name];
    if (value === undefined) continue;
    lines.push(`${role.name}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------- Validation (shared by pstack_config and the Task gate) ----------

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  /** Non-blocking: unknown/extra lines that a setup re-run drops. */
  warnings: string[];
}

export function validateRoles(roles: RoleMap, lookup: ModelLookup): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const role of ROLES) {
    const value = roles[role.name];
    if (value === undefined) {
      errors.push(`missing role "${role.name}"`);
      continue;
    }
    if (role.panel !== Array.isArray(value)) {
      errors.push(`role "${role.name}" must be ${role.panel ? "a list of models" : "a single model value"}`);
      continue;
    }
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length === 0 || entries.some((e) => !e.trim())) {
      errors.push(role.panel ? `panel role "${role.name}" is empty` : `role "${role.name}" has no value`);
      continue;
    }
    for (const entry of entries) {
      const checked = checkModelValue(entry, lookup);
      if (!checked.ok) errors.push(`role "${role.name}": ${checked.error}`);
    }
  }
  for (const name of Object.keys(roles)) {
    if (!ROLE_BY_NAME.has(name)) warnings.push(`unknown role "${name}"`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateConfigText(text: string | undefined, lookup: ModelLookup): ValidationReport {
  if (text === undefined) return { ok: false, errors: ["config file does not exist"], warnings: [] };
  const parsed = parseModelsRule(text);
  const report = validateRoles(parsed.roles, lookup);
  if (parsed.frontmatterError) report.errors.unshift(`invalid frontmatter: ${parsed.frontmatterError}`);
  else if (!parsed.alwaysApply) report.errors.unshift("frontmatter must set alwaysApply: true");
  if (!parsed.budget) report.warnings.push("no `# budget: <name> (<level>)` line");
  else if (!isBudgetName(parsed.budget.name)) report.warnings.push(`unknown budget "${parsed.budget.name}"`);
  for (const role of parsed.duplicateRoles) report.errors.push(`role "${role}" appears more than once`);
  for (const line of parsed.unknownLines) report.warnings.push(`unknown line "${line}"`);
  report.ok = report.errors.length === 0;
  return report;
}

export function formatReport(report: ValidationReport): string {
  const lines = [report.ok ? "Validation: ok" : "Validation: invalid"];
  for (const e of report.errors) lines.push(`- error: ${e}`);
  for (const w of report.warnings) lines.push(`- warning: ${w}`);
  return lines.join("\n");
}

// ---------- Task gate (R7 i–iii) ----------

export const NOT_CONFIGURED = "pstack is not configured: run /setup-pstack";

export type TaskModel = { kind: "parent" } | { kind: "model"; provider: string; id: string; level?: ModelThinkingLevel };

/** Omitted / `inherit-parent` / `auto` → parent model; otherwise a validated `provider/id[:level]`. */
export function resolveTaskModel(
  model: string | undefined,
  lookup: ModelLookup,
): { ok: true; model: TaskModel } | { ok: false; error: string } {
  if (model === undefined || model.trim() === "") return { ok: true, model: { kind: "parent" } };
  const checked = checkModelValue(model, lookup);
  if (!checked.ok) return checked;
  if (checked.ref.kind === "alias") return { ok: true, model: { kind: "parent" } };
  return { ok: true, model: checked.ref };
}

export type TaskGateResult =
  | { stage: "config"; text: string }
  | { stage: "model"; text: string }
  | { stage: "ok"; text: string; model: TaskModel };

export function taskGate(configText: string | undefined, model: string | undefined, lookup: ModelLookup): TaskGateResult {
  const report = validateConfigText(configText, lookup);
  if (!report.ok) return { stage: "config", text: `${NOT_CONFIGURED}\n\n${formatReport(report)}` };
  const resolved = resolveTaskModel(model, lookup);
  if (!resolved.ok) return { stage: "model", text: resolved.error };
  return { stage: "ok", text: "ok", model: resolved.model };
}
