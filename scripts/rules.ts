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
  "create-skill": "Cursor built-in skill-authoring skill; a later step ships a Pi equivalent.",
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
