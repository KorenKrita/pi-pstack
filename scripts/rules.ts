// Mechanical Cursor -> Pi adaptation rules, applied in order to every vendored text file.
// Longer / more specific paths come before the generic `~/.cursor/` fallback.

export type Rule = {
  id: string;
  description: string;
  find: string | RegExp;
  replace: string;
  /** Bun.Glob pattern matched against the output path (e.g. `skills/recall/SKILL.md`). */
  files?: string;
};

const SESSION_DIR = "`~/.pi/agent/sessions/<slug>/`";

export const RULES: Rule[] = [
  {
    id: "rules-dir",
    description:
      "User rules (incl. pstack-models.mdc) move from ~/.cursor/rules/ to ~/.pi/pstack/rules/; the extension loads them.",
    find: "~/.cursor/rules/",
    replace: "~/.pi/pstack/rules/",
  },
  {
    id: "recall-transcript-layout",
    description:
      "recall's description of Cursor's transcript layout rewritten to Pi's session JSONL layout and slug format.",
    files: "skills/recall/SKILL.md",
    find:
      'Transcripts live at `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each "/" turned into "-" (so `/Users/you/proj` becomes `Users-you-proj`). Every line is one chat message.',
    replace:
      'Transcripts are Pi session files at `~/.pi/agent/sessions/<slug>/<timestamp>_<uuid>.jsonl`, where `<slug>` is the workspace path with the leading slash dropped, each "/" turned into "-", and the result wrapped in `--` (so `/Users/you/proj` becomes `--Users-you-proj--`). Every line is one Pi session entry (JSON): a header, messages, tool results, and other session events.',
  },
  {
    id: "worktree-audit-session-dirs",
    description:
      "worktree-audit.sh: Pi keys sessions by launch cwd, so define a per-path session dir helper instead of one Cursor transcripts dir.",
    files: "skills/poteto-mode/scripts/worktree-audit.sh",
    find: [
      "# Transcripts dir: ~/.cursor/projects/<slugified-repo-path>/agent-transcripts.",
      "slug=$(printf '%s' \"$main_wt\" | sed 's#^/##; s#/#-#g')",
      'transcripts="$HOME/.cursor/projects/$slug/agent-transcripts"',
    ].join("\n"),
    replace: [
      "# Pi session JSONL lives under ~/.pi/agent/sessions/--<cwd, leading / dropped, / and : as ->--/,",
      "# keyed by the cwd pi was launched in. A worktree's chats sit under the main worktree's dir",
      "# (launched there, operating on the worktree) or under the worktree's own dir (launched inside it).",
      "session_dir() { printf '%s/.pi/agent/sessions/--%s--' \"$HOME\" \"$(printf '%s' \"$1\" | sed 's#^/##; s#[/:]#-#g')\"; }",
      'main_sessions=$(session_dir "$main_wt")',
    ].join("\n"),
  },
  {
    id: "worktree-audit-scan",
    description: "worktree-audit.sh: scan the main worktree's and the candidate's own session dirs.",
    files: "skills/poteto-mode/scripts/worktree-audit.sh",
    find: [
      '\tif [ -d "$transcripts" ]; then',
      '\t\tf=$(rg -l -e "${wt}/" -e "${wt}\\"" "$transcripts" 2>/dev/null \\',
    ].join("\n"),
    replace: [
      '\tdirs=(); for d in "$main_sessions" "$(session_dir "$wt")"; do [ -d "$d" ] && dirs+=("$d"); done',
      '\tif [ ${#dirs[@]} -gt 0 ]; then',
      '\t\tf=$(rg -l -e "${wt}/" -e "${wt}\\"" "${dirs[@]}" 2>/dev/null \\',
    ].join("\n"),
  },
  {
    id: "reflect-session-layout",
    description: "reflect: Pi keeps one JSONL file per session directly in the session dir.",
    files: "skills/reflect/SKILL.md",
    find: [
      "ls -t <agent-transcripts>/*.jsonl <agent-transcripts>/*/*.jsonl <agent-transcripts>/*/subagents/*.jsonl 2>/dev/null | head -10",
      "```",
      "",
      "Three transcript layouts: legacy flat (`<id>.jsonl`), current nested (`<id>/<id>.jsonl`), and subagent (`<parent>/subagents/<child>.jsonl`).",
    ].join("\n"),
    replace: [
      "ls -t <session-dir>/*.jsonl 2>/dev/null | head -10",
      "```",
      "",
      "Pi keeps one file per session, `<session-dir>/<timestamp>_<uuid>.jsonl`. Anything nested deeper (for example `<timestamp>_<uuid>/.../session.jsonl`) is a subagent run, not the parent.",
    ].join("\n"),
  },
  {
    id: "reflect-first-user-message",
    description:
      "reflect: Pi's first JSONL line is a `type: \"session\"` header; match the first user message, whose content is a string or a parts array.",
    files: "skills/reflect/SKILL.md",
    find: "For each candidate, read the first JSONL line and check that `message.content[0].text` contains the conversation's opening user prompt. Take the matching path.",
    replace: [
      "For each candidate, skip the `type: \"session\"` header line and other non-message entries, take the first entry with `type: \"message\"` and `message.role: \"user\"`, and check that its text contains the conversation's opening user prompt. `message.content` is either a string or an array of parts; use the first `type: \"text\"` part:",
      "",
      "```bash",
      "jq -rn 'first(inputs | select(.type == \"message\" and .message.role == \"user\") | .message.content | if type == \"string\" then . else (map(select(.type == \"text\")) | .[0].text) end)' <file>",
      "```",
      "",
      "Take the matching path.",
    ].join("\n"),
  },
  {
    id: "transcripts-dir-phrase",
    description:
      "\"the (active) workspace's `agent-transcripts/` directory\" -> Pi session directory (the extension names it in the system prompt).",
    find: /(the (?:active )?workspace's) `agent-transcripts\/` directory/g,
    replace: `$1 Pi session directory ${SESSION_DIR}`,
  },
  {
    id: "transcripts-dir-bare",
    description: "\"under `agent-transcripts/`\" -> under the Pi session directory.",
    find: "under `agent-transcripts/`",
    replace: `under the Pi session directory ${SESSION_DIR}`,
  },
  {
    id: "transcripts-placeholder",
    description: "Shell placeholder `<agent-transcripts>` -> `<session-dir>`.",
    find: "<agent-transcripts>",
    replace: "<session-dir>",
  },
  {
    id: "projects-dir",
    description: "Cursor per-workspace store ~/.cursor/projects/ -> Pi sessions root ~/.pi/agent/sessions/.",
    find: "~/.cursor/projects/",
    replace: "~/.pi/agent/sessions/",
  },
  {
    id: "user-skills-dir",
    description: "User-level skills ~/.cursor/skills/ -> ~/.pi/agent/skills/.",
    find: /(~|\$HOME)\/\.cursor\/skills\//g,
    replace: "$1/.pi/agent/skills/",
  },
  {
    id: "plugin-paths-phrase",
    description: "\"plugin-installed paths under ~/.cursor/plugins/\" -> Pi git-package install root.",
    find: "plugin-installed paths under `~/.cursor/plugins/`",
    replace: "package-installed paths under `~/.pi/agent/git/`",
  },
  {
    id: "plugins-dir",
    description: "Fallback: ~/.cursor/plugins/ -> ~/.pi/agent/git/ (where `pi install git:...` checks out packages).",
    find: "~/.cursor/plugins/",
    replace: "~/.pi/agent/git/",
  },
  {
    id: "subagents-dir",
    description: "~/.cursor/subagents/ -> ~/.pi/pstack/subagents/ (not present at the pinned commit; guards upstream drift).",
    find: "~/.cursor/subagents/",
    replace: "~/.pi/pstack/subagents/",
  },
  {
    id: "workspace-skills-dir",
    description:
      "Project skills (incl. generated `verify-<app>`) .cursor/skills/ -> .pi/skills/ (Pi's project skill dir).",
    // Any local path: bare, `./`, `../`, or `<dir>/`. `~/` and `$HOME/` forms were rewritten above.
    find: /(?<![\w-])\.cursor\/skills\//g,
    replace: ".pi/skills/",
  },
  {
    id: "home-cursor-fallback",
    description: "Any other ~/.cursor/ or $HOME/.cursor/ -> ~/.pi/pstack/ (pstack-owned state in Pi).",
    find: /(~|\$HOME)\/\.cursor\//g,
    replace: "$1/.pi/pstack/",
  },
  // ---------- per-role config reads in Pi (R4). Run after `rules-dir`. ----------
  {
    id: "arena-runner-config",
    description: "Arena runners use pstack_config read; never fall back to Cursor-only model slugs.",
    files: "skills/arena/SKILL.md",
    find: "3. Pick the runners. Use the `arena runners` line in `~/.pi/pstack/rules/pstack-models.mdc`. If the rule or that line is missing, default to one each on `claude-opus-5-5-max`, `gpt-5.6-sol-max`, `grok-4.7-xhigh-fast`. An `auto` or `inherit-parent` entry in this line or the cross-judge line means the parent model, so omit `model` for it. If the Task tool rejects a configured entry, run that seat on its family's default and say so. Families go by prefix: `claude-*`, `gpt-*`, and `grok-*`. With no family match, use `claude-opus-5-5-max`. If it rejects a default, use the closest valid slug of the same family from its error message. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.",
    replace: '3. Pick the runners. Call `pstack_config` with `action: "read"` and use its `arena runners` list only when validation is ok. The tool reads the active `$PSTACK_HOME` (or default) path; never read a fixed path. If missing or invalid, ask the user to run /setup-pstack and stop. For `auto` or `inherit-parent`, omit `model` to use the parent model. If Task rejects a configured model, show the error and ask for a valid Pi model id instead of guessing a Cursor slug. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.',
  },
  {
    id: "arena-judge-config",
    description: "Arena cross-judge uses the same active config path and Pi ids.",
    files: "skills/arena/SKILL.md",
    find: "After all Phase B candidates complete, choose one model from the `arena cross-judge pool` line in `~/.pi/pstack/rules/pstack-models.mdc`. If the rule or that line is missing, choose from `claude-opus-5-5-max`, `gpt-5.6-sol-max`, `grok-4.7-xhigh-fast`. Prefer a different model family from the parent's. Spawn one readonly judge subagent on that model. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the parent's reading in Phase D, not with the candidates themselves. Don't spawn the judge while candidates are still writing.",
    replace: 'After all Phase B candidates complete, use the `arena cross-judge pool` list from the validated `pstack_config` read above. Prefer a different available model from the parent\'s; omit `model` for `auto` or `inherit-parent`. Spawn one readonly judge subagent on that model. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the parent\'s reading in Phase D, not with the candidates themselves. Don\'t spawn the judge while candidates are still writing.',
  },
  {
    id: "swarm-worker-config",
    description: "Swarm worker reads model through the active config tool, not a default-home file.",
    files: "skills/swarm/SKILL.md",
    find: "4. Pick the worker model from the `swarm workers` line in `~/.pi/pstack/rules/pstack-models.mdc`. If the rule or that line is missing, use `grok-4.7-xhigh-fast`. For `auto` or `inherit-parent`, omit `model` so the workers run on the parent model. If the Task tool rejects a slug, use the default and say so. If it rejects the default, use the closest valid slug of the same family from its error message. For a model race, name each arm's model up front.",
    replace: '4. Call `pstack_config` with `action: "read"` and use its `swarm workers` value only when validation is ok. The tool reads the active `$PSTACK_HOME` (or default) path; never read a fixed path. If missing or invalid, ask the user to run /setup-pstack and stop. For `auto` or `inherit-parent`, omit `model` so workers run on the parent model. If Task rejects the configured Pi model id, show its error and ask for a valid choice instead of guessing a Cursor slug. For a model race, name each arm\'s model up front.',
  },
  {
    id: "interrogate-reviewer-config",
    description: "Interrogate reviewer panel reads the active Pi config instead of Cursor defaults.",
    files: "skills/interrogate/SKILL.md",
    find: /Launch all reviewers in a single message using the Task tool\. Use the `interrogate reviewers` line in `~\/\.pi\/pstack\/rules\/pstack-models\.mdc`[\s\S]*?Never treat an alias entry as a rejected slug or apply either fallback to it\./g,
    replace: 'Call `pstack_config` with `action: "read"` and use its `interrogate reviewers` list only when validation is ok. The tool reads the active `$PSTACK_HOME` (or default) path; never read a fixed path. If missing or invalid, ask the user to run /setup-pstack and stop. Launch one reviewer per configured entry in a single message using Task, extending or shrinking the Reviewer A/B/C labels below to that count. The table is an illustration, not default model choices; only the configured Pi ids are valid.\n\n| Subagent | Configured model |\n|----------|------------------|\n| Reviewer A/B/C (as many as configured) | Corresponding `interrogate reviewers` entry |\n\nFor each reviewer:\n- `subagent_type`: `generalPurpose`\n- `model`: the configured Pi model id; for `auto` or `inherit-parent`, omit `model` so the reviewer uses the parent model.\n- `readonly`: `true`\n\nIf Task rejects an entry, show its error and ask for a valid Pi model id. Do not guess a Cursor slug or treat an alias as a rejected model.',
  },
  // ---------- setup-pstack in Pi (R5). These run after `rules-dir`, so they match `~/.pi/pstack/`. ----------
  {
    id: "setup-intro",
    description: "setup-pstack intro: the config path is $PSTACK_HOME-relative and written by the pstack_config tool.",
    files: "skills/setup-pstack/SKILL.md",
    find: "Write `~/.pi/pstack/rules/pstack-models.mdc`, an always-applied rule that sets pstack's model per role.",
    replace:
      "Write `$PSTACK_HOME/rules/pstack-models.mdc` (default `~/.pi/pstack/rules/pstack-models.mdc`) through the `pstack_config` tool: an always-applied rule that sets pstack's model per role.",
  },
  {
    id: "setup-detect-models",
    description:
      "setup-pstack step 1: enumerate models from the extension's adapter-note list (configured credentials) instead of probing Task.",
    files: "skills/setup-pstack/SKILL.md",
    find: "Enumerate the model slugs you can pass to a `Task` subagent in this session. That is the dependable source. If Cursor also exposes a models API or CLI that lists the user's entitled models, prefer it for completeness. If you cannot detect any, ask the user to paste the slugs they have access to. Never write a real slug you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected slugs.",
    replace:
      "Use the candidate model list in the pstack adapter note of the system prompt: models with configured credentials in Pi, each with its supported thinking levels. That is the dependable source; do not call `Task` to probe. If the list is empty, ask the user to configure a provider in Pi (log in to a subscription, set an API key, or add a custom provider in `~/.pi/agent/models.json`) and stop. Never write a model id that is not in that list. Values are Pi ids `provider/id` with an optional `:<thinking>` suffix. The aliases `inherit-parent` and `auto` are always valid even though they are not listed models.",
  },
  {
    id: "setup-load-state",
    description:
      "setup-pstack step 2: read current state through pstack_config; with no config every role needs a choice (upstream Cursor slugs are not Pi ids, and inherit-parent is never assumed).",
    files: "skills/setup-pstack/SKILL.md",
    find: "The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.pi/pstack/rules/pstack-models.mdc` already exists, read it and treat its `# budget` line and its role values as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.",
    replace:
      "Call the `pstack_config` tool with `action: \"read\"`. It returns the config path (`$PSTACK_HOME/rules/pstack-models.mdc`, default `~/.pi/pstack/rules/pstack-models.mdc`), the parsed `budget` and role values, and a validation report. If the file exists, treat its `# budget` line and its role values as the current choices. Otherwise every role in step 5 starts as needing a choice: pstack ships no default models for Pi, and `inherit-parent` is never assumed silently. A line whose role is not in step 5, such as `how critics`, is from a retired role (the report lists it as unknown). Drop it.",
  },
  {
    id: "setup-apply-budget",
    description: "setup-pstack step 3b: budget maps to Pi thinking levels, clamped to each model's supported levels.",
    files: "skills/setup-pstack/SKILL.md",
    find: "**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited` leaves every effort as in that table. `large`, `medium`, and `small` set the effort token of every real slug, panel entries included, to `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If the result is not a detected slug, use the same family's detected slug with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `small` turns `claude-opus-5-5-max` into `claude-opus-5-5-medium`, and `grok-4.7-xhigh-fast` into `grok-4.7-medium-fast`.",
    replace:
      "**(b) Apply it.** Build the working table from the current choices of step 2; roles without a value stay as needing a choice. On a re-run keep every role's model, list, or alias (`inherit-parent`, `auto`). The budget sets the `:<thinking>` suffix of every real model, panel entries included: `unlimited` keeps each entry's own level (`max` when it has none), and `large`, `medium`, and `small` target `xhigh`, `high`, and `medium`. The ladder is `max` > `xhigh` > `high` > `medium` > `low` > `minimal`. Use the highest level in that model's supported list (adapter note) at or below the target; a model that supports only `off` is written without a suffix. If no supported level is at or below the target, mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `small` turns `<provider>/<id>:max` into `<provider>/<id>:medium`, and under `unlimited` a model whose levels stop at `high` gets `:high`. The `pstack_config` write tool applies this mapping too; show and confirm this final mapped table, not the unmapped choices, before calling write. Resolve every needs-a-choice role first: write rejects unmappable entries without changing the file.",
  },
  {
    id: "setup-confirm-roles",
    description:
      "setup-pstack step 3c: show the full table, resolve every needs-a-choice role per role or per group, and let the user edit panel membership.",
    files: "skills/setup-pstack/SKILL.md",
    find: "Show every role with its model, marking any real slug not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Prefer AskQuestion over free text.",
    replace:
      "Show the full table: every role with its value, marking each role that needs a choice and any model not in the adapter-note list. Also list each line step 2 dropped. While any role needs a choice, ask for it, per role or per group: code roles (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `how explorer`, `why investigators`, `swarm workers`), judgment and prose roles (`judgment and prose`, `hardest tasks`, `how explainer`, `why synthesizer`, `reflect judgment, divergent, synthesizer`), reflect tooling (`reflect tooling`), and panels (`arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`), where the user also edits panel membership (add, remove, or replace entries). Offer the listed models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model) as the options. Then show the full table again and ask whether to accept it as-is or change specific roles. Prefer AskQuestion over free text.",
  },
  {
    id: "setup-validate",
    description: "setup-pstack step 4: pstack_config write validates against Pi's model registry.",
    files: "skills/setup-pstack/SKILL.md",
    find: "Every real slug written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen real slug is not available, stop and ask again.",
    replace:
      "`pstack_config` `write` validates before writing: every role in step 5 present, panel lists non-empty, and each value `inherit-parent`, `auto`, or a `provider/id[:level]` that exists in Pi with configured credentials and supports that level. `inherit-parent` and `auto` always pass. If it rejects the config, nothing is written: show the report, ask again for the failing roles, and retry.",
  },
  {
    id: "setup-write-rule",
    description:
      "setup-pstack step 5: write through the pstack_config tool (it owns the path and the atomic write); the shape shows placeholders, not upstream Cursor slugs.",
    files: "skills/setup-pstack/SKILL.md",
    find: /Write `~\/\.pi\/pstack\/rules\/pstack-models\.mdc` with `alwaysApply: true`[\s\S]*?\ninterrogate reviewers: [^\n]*\n```/g,
    replace: [
      'After the user confirms the fully mapped table, call the `pstack_config` tool with `action: "write"`, the chosen `budget` name (`unlimited`, `large`, `medium`, or `small`), and `roles`: every role below mapped to its value, as a list of strings for the four panel roles. Do not write the file by hand: the tool picks the path (`$PSTACK_HOME/rules/pstack-models.mdc`, default `~/.pi/pstack/rules/pstack-models.mdc`) and overwrites the whole file atomically, so re-runs stay idempotent. The file has `alwaysApply: true`, a `# budget` line with the chosen budget and its target level, and one line per role, using the same labels poteto-mode uses. Shape (values are placeholders):',
      "",
      "```",
      "---",
      "description: pstack per-role model choices (overrides skill defaults)",
      "alwaysApply: true",
      "---",
      "# pstack model configuration. One line per role. Every role is required; re-run /setup-pstack to change it.",
      "# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.",
      "# budget: unlimited (max)",
      "feature, refactoring: <provider>/<id>:<level>",
      "bug-fix: <provider>/<id>:<level>",
      "perf-issue: <provider>/<id>:<level>",
      "hillclimb: <provider>/<id>:<level>",
      "judgment and prose: <provider>/<id>:<level>",
      "hardest tasks: <provider>/<id>:<level>",
      "how explorer: <provider>/<id>:<level>",
      "how explainer: <provider>/<id>:<level>",
      "why investigators: <provider>/<id>:<level>",
      "why synthesizer: <provider>/<id>:<level>",
      "reflect tooling: <provider>/<id>:<level>",
      "reflect judgment, divergent, synthesizer: <provider>/<id>:<level>",
      "arena runners: <provider>/<id>:<level>, <provider>/<id>:<level>, inherit-parent",
      "arena cross-judge pool: <provider>/<id>:<level>, <provider>/<id>:<level>",
      "swarm workers: <provider>/<id>:<level>",
      "architect runners: <provider>/<id>:<level>, <provider>/<id>:<level>, <provider>/<id>:<level>",
      "interrogate reviewers: <provider>/<id>:<level>, <provider>/<id>:<level>, <provider>/<id>:<level>",
      "```",
    ].join("\n"),
  },
  {
    id: "setup-applies-when",
    description: "setup-pstack step 6: the extension re-reads always-apply rules every turn, so the config applies from the next turn.",
    files: "skills/setup-pstack/SKILL.md",
    find: "Tell the user the rule was written and that it applies to new sessions.",
    replace:
      "Tell the user the rule was written (the path `pstack_config` returned) and that it applies from the next turn, since pstack injects always-applied rules on every turn while active.",
  },
];

/** Bare `.cursor/` references that intentionally survive adaptation. `file` is an output path. */
export const CURSOR_ALLOWLIST: { file: string; text: string; reason: string }[] = [
  {
    file: "skills/poteto-mode/playbooks/worktree-cleanup.md",
    text: ".cursor/worktrees/myrepo/x",
    reason:
      "Illustrative example of a worktree living outside the hand-typed `<repo>-worktrees/` guess; the lesson (read `git worktree list`) holds regardless of tool.",
  },
];

/** Skill names referenced in prose that are not vendored here but are expected to exist. */
export const EXTERNAL_SKILLS: Record<string, string> = {
  "create-skill": "Cursor built-in skill-authoring skill; pi-pstack ships its own in extras/skills/create-skill.",
  babysit: "Cursor built-in PR babysit skill; poteto-mode explicitly routes away from it.",
  loop: "Cursor `/loop` built-in command; the extension must provide it.",
  goal: "Cursor `/goal` built-in command; the extension must provide it.",
};

const URL_RE = /https?:\/\/[^\s)`'"<>\]]+/g;

/** Apply rules outside URLs. Returns new text and per-rule hit counts (added into `hits`). */
export function applyRules(
  path: string,
  text: string,
  rules: Rule[] = RULES,
  hits: Record<string, number> = {},
): string {
  let out = text;
  for (const rule of rules) {
    if (rule.files && !new Bun.Glob(rule.files).match(path)) continue;
    const re =
      typeof rule.find === "string"
        ? new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
        : rule.find;
    // String rules are literal: escape `$` so shell `$HOME` etc. survive.
    const replacement = typeof rule.find === "string" ? rule.replace.replaceAll("$", "$$$$") : rule.replace;
    let count = 0;
    out = splitUrls(out)
      .map(([seg, isUrl]) => {
        if (isUrl) return seg;
        count += seg.match(re)?.length ?? 0;
        return seg.replace(re, replacement);
      })
      .join("");
    hits[rule.id] = (hits[rule.id] ?? 0) + count;
  }
  return out;
}

/** Text with URLs blanked out, for checks that must ignore URLs. */
export function stripUrls(text: string): string {
  return text.replace(URL_RE, (u) => " ".repeat(u.length));
}

/** A file is binary if it contains a NUL byte. */
export function isBinary(data: Uint8Array): boolean {
  return data.includes(0);
}

function splitUrls(text: string): [string, boolean][] {
  const parts: [string, boolean][] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    parts.push([text.slice(last, m.index), false], [m[0], true]);
    last = m.index + m[0].length;
  }
  parts.push([text.slice(last), false]);
  return parts;
}

/** Pi skill name: lowercase a-z 0-9 and single hyphens, <= 64 chars. */
export function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}
