// pi-pstack extension: activation state, /pstack and per-skill commands, per-turn prompt
// injection, and the AskQuestion / Task / pstack_config tools. Pure logic lives in config.ts
// and rules.ts; this file is Pi wiring only.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BUDGETS,
  formatReport,
  isBudgetName,
  lookupFromRegistry,
  modelsRulePath,
  parseModelsRule,
  pstackHome,
  readModelsRule,
  serializeModelsRule,
  taskGate,
  validateConfigText,
  validateRoles,
  writeModelsRule,
  type RoleMap,
} from "./config";
import { loadAlwaysApplyRules, modeReminders, parseSkillMeta, pathHintKey, pathHints, type SkillMeta } from "./rules";

export const STATE_ENTRY = "pstack-state";
export const POTETO_SKILL = "poteto-mode";
export const POTETO_GRANT =
  "The user explicitly enabled /poteto-mode. Treat this as the full-autonomy grant that poteto-mode's Autonomy section describes, and let poteto-mode's reply format take precedence over generic formatting guidance. Explicit user instructions in this conversation, safety constraints, and AGENTS.md permission/destructive-action rules still take precedence over poteto-mode.";

export interface PstackState {
  active: boolean;
  poteto: boolean;
}

const OFF: PstackState = { active: false, poteto: false };

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolve a `read`/`edit`/`write` path argument the way Pi's file tools do (`@` prefix, `~`, cwd-relative). */
function resolveToolPath(raw: string, cwd: string): string {
  let path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

interface OwnSkill {
  meta: SkillMeta;
  file: string;
}

function loadOwnSkills(skillsDir: string): OwnSkill[] {
  const skills: OwnSkill[] = [];
  for (const dir of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(skillsDir, dir.name, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    skills.push({ meta: parseSkillMeta(text, dir.name), file });
  }
  return skills.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

/** Reconstruct the activation state from the current branch: the last `pstack-state` entry wins. */
export function stateFromBranch(entries: readonly { type: string; customType?: string; data?: unknown }[]): PstackState {
  let state = OFF;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const data = entry.data as Partial<PstackState> | undefined;
    state = { active: data?.active === true, poteto: data?.active === true && data?.poteto === true };
  }
  return state;
}

const QUESTION_PARAMS = Type.Object({
  title: Type.Optional(Type.String({ description: "Optional heading shown above the questions" })),
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Stable id returned with the answer" }),
      prompt: Type.String({ description: "Question shown to the user" }),
      options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() }), { minItems: 1 }),
      allow_multiple: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option" })),
    }),
    { minItems: 1 },
  ),
});

const TASK_PARAMS = Type.Object({
  description: Type.String({ description: "Short (3-5 word) task description" }),
  prompt: Type.String({ description: "Full instructions for the subagent" }),
  subagent_type: Type.Optional(Type.String()),
  model: Type.Optional(
    Type.String({ description: "Pi model id provider/id[:thinking]; omit, `inherit-parent`, or `auto` for the parent model" }),
  ),
  readonly: Type.Optional(Type.Boolean()),
  run_in_background: Type.Optional(Type.Boolean()),
  resume: Type.Optional(Type.String({ description: "Id of a previous Task to resume" })),
  environment: Type.Optional(Type.String({ description: "Upstream `cloud` runs as the local substitute" })),
});

const CONFIG_PARAMS = Type.Object({
  action: StringEnum(["read", "write"] as const),
  roles: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
      description: "write: every role -> model value; panel roles take a list",
    }),
  ),
  budget: Type.Optional(StringEnum(Object.keys(BUDGETS) as (keyof typeof BUDGETS)[])),
});

const OWNED_TOOL_NAMES = ["Task", "AskQuestion", "pstack_config"] as const;

export interface PstackOptions {
  /** This package's `skills/` dir. Default: resolved from this file's location. */
  skillsDir?: string;
}

export function pstackExtension(pi: ExtensionAPI, options: PstackOptions = {}): void {
  const skillsDir = options.skillsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  const skills = loadOwnSkills(skillsDir);
  const skillMetas = skills.map((s) => s.meta);
  /** realpath of each own SKILL.md → skill name. */
  const ownSkillFiles = new Map(skills.map((s) => [realpathOrSelf(s.file), s.meta.name]));

  let state: PstackState = OFF;
  /** Tools this extension registered (and therefore may toggle). */
  const ownedTools = new Set<string>();
  const toolCollisions: string[] = [];
  const commandCollisions = new Set<string>();
  const shownHints = new Set<string>();
  const pendingHints: string[] = [];
  const shownWarnings = new Set<string>();

  const warn = (ctx: ExtensionContext, message: string) => {
    if (shownWarnings.has(message)) return;
    shownWarnings.add(message);
    ctx.ui.notify(message, "warning");
  };

  const applyTools = () => {
    const current = pi.getActiveTools();
    const next = state.active
      ? [...new Set([...current, ...ownedTools])]
      : current.filter((name) => !ownedTools.has(name));
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) pi.setActiveTools(next);
  };

  const setState = (next: PstackState) => {
    if (next.active === state.active && next.poteto === state.poteto) return;
    state = next;
    pi.appendEntry(STATE_ENTRY, { ...state });
    applyTools();
  };

  const activate = (poteto: boolean) => setState({ active: true, poteto: state.poteto || poteto });

  /** Name of the own skill that Pi's `/skill:<name>` resolves to, or undefined (unknown or another package's skill). */
  const resolveSkillCommand = (name: string): string | undefined => {
    const command = pi.getCommands().find((c) => c.source === "skill" && c.name === `skill:${name}`);
    if (!command) return undefined;
    return ownSkillFiles.get(realpathOrSelf(command.sourceInfo.path));
  };

  const reconcile = (ctx: ExtensionContext) => {
    state = stateFromBranch(ctx.sessionManager.getBranch());
    applyTools();
  };

  // ---------- tools ----------

  const registerOwned = (ctx: ExtensionContext) => {
    const existing = new Set(pi.getAllTools().map((t) => t.name));
    for (const name of OWNED_TOOL_NAMES) {
      if (ownedTools.has(name) || toolCollisions.includes(name)) continue;
      if (existing.has(name)) {
        toolCollisions.push(name);
        warn(ctx, `pstack: tool "${name}" is already registered by another extension; pstack runs without its own ${name}.`);
        continue;
      }
      registerTool(name);
      ownedTools.add(name);
    }
  };

  const registerTool = (name: (typeof OWNED_TOOL_NAMES)[number]) => {
    if (name === "AskQuestion") {
      pi.registerTool({
        name,
        label: "AskQuestion",
        description:
          "Ask the user one or more multiple-choice questions and wait for the answers. Returns the selected option ids and labels per question.",
        parameters: QUESTION_PARAMS,
        defaultActive: false,
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const result = await askQuestions(params, ctx);
          const text = result.cancelled
            ? `The user cancelled AskQuestion. Answers given before cancelling: ${JSON.stringify(result.answers)}`
            : JSON.stringify(result.answers, null, 2);
          return { content: [{ type: "text", text }], details: result };
        },
      });
    } else if (name === "Task") {
      pi.registerTool({
        name,
        label: "Task",
        description:
          "Launch a subagent for a delegated task. `model` is a Pi id provider/id[:thinking]; omit it (or pass inherit-parent/auto) to use the parent model.",
        parameters: TASK_PARAMS,
        defaultActive: false,
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const gate = taskGate(readModelsRule(pstackHome()), params.model, lookupFromRegistry(ctx.modelRegistry));
          throw new Error(gate.text);
        },
      });
    } else {
      pi.registerTool({
        name,
        label: "pstack_config",
        description:
          "Read or write the pstack per-role model configuration. `read` returns the parsed config and a validation report. `write` takes the full role->value map plus budget, validates it, and writes the rule file atomically.",
        parameters: CONFIG_PARAMS,
        defaultActive: false,
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const result = runConfigTool(params, ctx);
          return { content: [{ type: "text", text: result.text }], details: result.details };
        },
      });
    }
  };

  // ---------- events ----------

  pi.on("session_start", (_event, ctx) => {
    registerOwned(ctx);
    registerCommands(ctx);
    shownHints.clear();
    pendingHints.length = 0;
    reconcile(ctx);
  });

  pi.on("session_tree", (_event, ctx) => reconcile(ctx));

  pi.on("input", (event) => {
    if (event.text.startsWith("/skill:")) {
      const space = event.text.indexOf(" ");
      const name = space === -1 ? event.text.slice(7) : event.text.slice(7, space);
      const own = resolveSkillCommand(name);
      if (own) activate(own === POTETO_SKILL);
    }
    return { action: "continue" };
  });

  pi.on("tool_result", (event, ctx) => {
    const raw = event.input.path;
    if (typeof raw !== "string" || event.isError) return;
    const path = resolveToolPath(raw, ctx.cwd);
    if (event.toolName === "read" && ownSkillFiles.has(realpathOrSelf(path))) activate(false);
    if (!state.active || !["read", "edit", "write"].includes(event.toolName)) return;
    for (const hint of pathHints(skillMetas, path, ctx.cwd, shownHints)) {
      shownHints.add(hint.key);
      const skill = skills.find((s) => hint.key.startsWith(pathHintKey(s.meta.name, "")));
      pendingHints.push(skill ? `${hint.text} (${skill.file})` : hint.text);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.active) return;
    const sections = buildSections(ctx);
    for (const [name, text] of sections) event.systemPromptOptions.sections[name] = text;
  });

  const buildSections = (ctx: ExtensionContext): [string, string][] => {
    const home = pstackHome();
    const out: [string, string][] = [["pstack_adapter", adapterNote(ctx, home)]];
    const loaded = loadAlwaysApplyRules(join(home, "rules"));
    for (const w of loaded.warnings) warn(ctx, w);
    if (loaded.rules.length) {
      out.push(["pstack_rules", loaded.rules.map((r) => `<!-- ${r.file} -->\n${r.body.trim()}`).join("\n\n")]);
    }
    if (state.poteto) out.push(["pstack_mode", [...modeReminders(skillMetas), POTETO_GRANT].join("\n\n")]);
    if (pendingHints.length) {
      out.push(["pstack_paths", `${pendingHints.join("\n")}\n(Plugin approximation of Cursor's \`paths\` skill field.)`]);
      pendingHints.length = 0;
    }
    return out;
  };

  const adapterNote = (ctx: ExtensionContext, home: string): string => {
    const models = ctx.modelRegistry
      .getAvailable()
      .map((m) => `- ${m.provider}/${m.id} (thinking: ${getSupportedThinkingLevels(m).join(", ")})`);
    const tools = [...ownedTools].filter((t) => t !== "pstack_config");
    const sessionFile = ctx.sessionManager.getSessionFile();
    return [
      "pstack skills were written for Cursor; in Pi they run through this plugin.",
      tools.length
        ? `- Built-ins provided here: ${tools.join(", ")} (use the schemas shown in their tool declarations).`
        : "- Task and AskQuestion are not provided (name collision with another extension); ask in plain text and do the work yourself.",
      "- Model values are Pi ids `provider/id` with an optional `:<thinking>` suffix (off|minimal|low|medium|high|xhigh|max; support varies per model). `inherit-parent` or `auto` = omit `model`.",
      `- pstack config: ${modelsRulePath(home)}. Write it only through the pstack_config tool.`,
      "- Candidate models for Task (configured credentials, not a liveness check):",
      ...(models.length ? models : ["- (none)"]),
      `- Transcripts are Pi JSONL under ${ctx.sessionManager.getSessionDir()}${sessionFile ? ` (this session: ${sessionFile})` : ""}.`,
      '- Everything runs locally: an upstream `environment: "cloud"` request runs as the approved local substitute, with no cloud isolation or survive-shutdown guarantee.',
      "- Bugbot is an external GitHub product, not a tool here.",
    ].join("\n");
  };

  // ---------- commands ----------
  // Registered at session_start (not at load) so collisions with commands and prompt templates
  // that already exist can be detected and skipped instead of shadowing them.

  let commandsRegistered = false;
  const registerCommands = (ctx: ExtensionContext) => {
    if (commandsRegistered) return;
    commandsRegistered = true;
    const taken = new Set(pi.getCommands().filter((c) => c.source !== "skill").map((c) => c.name.replace(/:\d+$/, "")));
    const tryRegister = (name: string, register: () => void) => {
      if (taken.has(name)) {
        commandCollisions.add(name);
        warn(ctx, `pstack: command "/${name}" already exists; pstack's /${name} is not registered.`);
      } else register();
    };
    tryRegister("pstack", () =>
      pi.registerCommand("pstack", {
        description: "pstack: on | off | status",
        handler: async (args, cmdCtx) => {
          const sub = args.trim();
          if (sub === "on") {
            activate(false);
            cmdCtx.ui.notify("pstack: active", "info");
          } else if (sub === "off") {
            setState(OFF);
            cmdCtx.ui.notify("pstack: off", "info");
          } else if (sub === "status" || sub === "") {
            cmdCtx.ui.notify(statusText(cmdCtx), "info");
          } else {
            cmdCtx.ui.notify("Usage: /pstack on | off | status", "warning");
          }
        },
      }),
    );
    for (const meta of skillMetas) {
      tryRegister(meta.name, () =>
        pi.registerCommand(meta.name, {
          description: `pstack: run skill ${meta.name}`,
          handler: async (args, cmdCtx) => {
            if (resolveSkillCommand(meta.name) !== meta.name) {
              cmdCtx.ui.notify(`pstack: Pi does not resolve /skill:${meta.name} to this package's skill (is its skills dir loaded?).`, "error");
              return;
            }
            activate(meta.name === POTETO_SKILL);
            const text = args.trim() ? `/skill:${meta.name} ${args.trim()}` : `/skill:${meta.name}`;
            // expandPromptTemplates routes the text through Pi's own /skill: expansion, so the block is identical.
            pi.sendUserMessage(text, cmdCtx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" });
          },
        }),
      );
    }
  };

  const statusText = (ctx: ExtensionContext): string => {
    const home = pstackHome();
    const report = validateConfigText(readModelsRule(home), lookupFromRegistry(ctx.modelRegistry));
    const lines = [
      `pstack: ${state.active ? "active" : "inactive"}${state.poteto ? " (poteto mode)" : ""}`,
      `tools: ${[...ownedTools].join(", ") || "(none)"}`,
      `config: ${modelsRulePath(home)}`,
      formatReport(report),
    ];
    if (toolCollisions.length) lines.push(`tool collisions (not provided): ${toolCollisions.join(", ")}`);
    if (commandCollisions.size) lines.push(`command collisions (not registered): ${[...commandCollisions].map((c) => `/${c}`).join(", ")}`);
    return lines.join("\n");
  };
}

// ---------- AskQuestion (R6) ----------

export type AskQuestionParams = {
  title?: string;
  questions: { id: string; prompt: string; options: { id: string; label: string }[]; allow_multiple?: boolean }[];
};

export type AskQuestionResult =
  | { cancelled: true; answers: { id: string; selected: { id: string; label: string }[] }[] }
  | { cancelled: false; answers: { id: string; selected: { id: string; label: string }[] }[] };

export async function askQuestions(
  params: AskQuestionParams,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<AskQuestionResult> {
  if (!ctx.hasUI) {
    throw new Error("AskQuestion needs an interactive UI, which this session does not have. Ask the user the question in plain text instead.");
  }
  const answers: { id: string; selected: { id: string; label: string }[] }[] = [];
  for (const q of params.questions) {
    const heading = params.title ? `${params.title}\n${q.prompt}` : q.prompt;
    const labels = q.options.map((o, i) => `${i + 1}. ${o.label}`);
    if (!q.allow_multiple) {
      const choice = await ctx.ui.select(heading, labels);
      const index = choice === undefined ? -1 : labels.indexOf(choice);
      if (index === -1) return { cancelled: true, answers };
      answers.push({ id: q.id, selected: [q.options[index] as { id: string; label: string }] });
      continue;
    }
    const picked = new Set<number>();
    const done = "Done";
    for (;;) {
      const shown = labels.map((l, i) => `${picked.has(i) ? "[x]" : "[ ]"} ${l}`);
      const choice = await ctx.ui.select(`${heading}\n(select to toggle, then Done)`, [...shown, done]);
      if (choice === undefined) return { cancelled: true, answers };
      if (choice === done) break;
      const index = shown.indexOf(choice);
      if (index === -1) return { cancelled: true, answers };
      if (picked.has(index)) picked.delete(index);
      else picked.add(index);
    }
    answers.push({ id: q.id, selected: [...picked].sort((a, b) => a - b).map((i) => q.options[i] as { id: string; label: string }) });
  }
  return { cancelled: false, answers };
}

// ---------- pstack_config (R5) ----------

export function runConfigTool(
  params: { action: "read" | "write"; roles?: RoleMap; budget?: string },
  ctx: Pick<ExtensionContext, "modelRegistry">,
): { text: string; details: unknown } {
  const home = pstackHome();
  const path = modelsRulePath(home);
  const lookup = lookupFromRegistry(ctx.modelRegistry);
  if (params.action === "read") {
    const text = readModelsRule(home);
    const report = validateConfigText(text, lookup);
    const parsed = text === undefined ? undefined : parseModelsRule(text);
    const details = { path, exists: text !== undefined, budget: parsed?.budget, roles: parsed?.roles ?? {}, report };
    return { text: `${JSON.stringify({ path, exists: details.exists, budget: details.budget, roles: details.roles }, null, 2)}\n\n${formatReport(report)}`, details };
  }
  if (!params.roles) throw new Error("pstack_config write needs `roles` (the full role -> value map).");
  if (!params.budget || !isBudgetName(params.budget)) {
    throw new Error(`pstack_config write needs \`budget\`, one of: ${Object.keys(BUDGETS).join(", ")}.`);
  }
  const report = validateRoles(params.roles, lookup);
  if (!report.ok) throw new Error(`Config not written (${path}).\n${formatReport(report)}`);
  writeModelsRule(home, serializeModelsRule(params.roles, params.budget));
  const written = validateConfigText(readModelsRule(home), lookup);
  return { text: `Wrote ${path}\n${formatReport({ ...written, warnings: [...report.warnings, ...written.warnings] })}`, details: { path, report: written } };
}

export default function (pi: ExtensionAPI): void {
  pstackExtension(pi);
}
