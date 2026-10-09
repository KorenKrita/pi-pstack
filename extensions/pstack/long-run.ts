// /goal and /loop state, parsing and decisions. Pi wiring is in index.ts.

export const GOAL_ENTRY = "pstack-goal";
export const LOOP_ENTRY = "pstack-loop";
export const GOAL_CONTINUE_MESSAGE = "pstack-goal-continue";
export const LOOP_TICK_MESSAGE = "pstack-loop-tick";

// ---------- /goal ----------

export type GoalStatus = "active" | "paused" | "done" | "cleared";
export interface Goal {
  objective: string;
  status: GoalStatus;
  /** Why it is paused or done (GoalDone summary, abort, error). */
  note?: string;
  since: string;
}

/** Last `pstack-goal` entry on the branch; cleared/done goals count as no goal. */
export function goalFromBranch(entries: readonly any[]): Goal | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "custom" && e.customType === GOAL_ENTRY && e.data && typeof e.data.objective === "string") {
      return e.data as Goal;
    }
  }
  return undefined;
}

export function goalSection(goal: Goal): string {
  return [
    `Armed goal (/goal): ${goal.objective}`,
    "Keep working toward it across turns until it is fully complete. When it is complete and verified, call GoalDone with the evidence.",
    "If you are blocked on something only the user can provide, call GoalDone with blocked: true and the question.",
  ].join("\n");
}

export const GOAL_CONTINUE_TEXT =
  "The armed /goal is not marked done. Continue toward it now. Call GoalDone when it is complete and verified, or GoalDone with blocked: true if you need the user.";

export interface SettleInput {
  goal: Goal | undefined;
  pstackActive: boolean;
  outcome: "completed" | "aborted" | "error";
  /** Another handler already requested a continuation. */
  alreadyContinuing: boolean;
  /** User input is queued; it runs next anyway. */
  pendingInput: boolean;
}

export type SettleDecision = { kind: "none" } | { kind: "continue" } | { kind: "pause"; note: string };

/** What /goal does at agent_before_settle. No iteration cap: the goal runs until GoalDone or the user stops it. */
export function decideGoalSettle(i: SettleInput): SettleDecision {
  if (!i.goal || i.goal.status !== "active" || !i.pstackActive) return { kind: "none" };
  if (i.outcome === "aborted") return { kind: "pause", note: "paused: run aborted by the user" };
  if (i.outcome === "error") return { kind: "pause", note: "paused: the run ended with an error" };
  if (i.alreadyContinuing || i.pendingInput) return { kind: "none" };
  return { kind: "continue" };
}

// ---------- /loop ----------

export const MIN_LOOP_MS = 30_000;
export const MAX_LOOP_MS = 86_400_000;
export const DYNAMIC_DEFAULT_MS = 600_000;

export interface Loop {
  id: string;
  prompt: string;
  /** Fixed interval; undefined = dynamic (the agent schedules the next wake with LoopSchedule). */
  intervalMs?: number;
  sessionId: string;
  createdAt: string;
}

export type LoopEntry =
  | { op: "add"; loop: Loop }
  | { op: "stop"; id: string }
  | { op: "schedule"; id: string; nextAt: number };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNIT_WORDS: Record<string, string> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s",
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
};

/** "30s", "5m", "5 minutes", "2h", "1d" → ms; undefined when not an interval. */
export function parseInterval(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(text.trim());
  if (!m) return undefined;
  const unit = UNIT_WORDS[m[2]!.toLowerCase()];
  if (!unit) return undefined;
  return Math.round(Number(m[1]) * UNIT_MS[unit]!);
}

/** `/loop [interval] <prompt>` or `/loop <prompt> every <interval>`. */
export function parseLoopArgs(args: string): { prompt: string; intervalMs?: number } | { error: string } {
  const text = args.trim();
  if (!text) return { error: "Usage: /loop [interval] <prompt> | /loop <prompt> every <interval> | /loop list | /loop stop [id|all]" };
  let prompt = text;
  let intervalMs: number | undefined;
  const lead = /^(\d+(?:\.\d+)?\s*[a-z]+)\s+([\s\S]+)$/i.exec(text);
  const leadMs = lead ? parseInterval(lead[1]!) : undefined;
  if (lead && leadMs !== undefined) {
    intervalMs = leadMs;
    prompt = lead[2]!;
  } else {
    const trail = /^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?\s*[a-z]+)$/i.exec(text);
    const trailMs = trail ? parseInterval(trail[2]!) : undefined;
    if (trail && trailMs !== undefined) {
      intervalMs = trailMs;
      prompt = trail[1]!;
    }
  }
  prompt = prompt.trim();
  if (!prompt) return { error: "The loop needs a prompt." };
  if (intervalMs !== undefined && (intervalMs < MIN_LOOP_MS || intervalMs > MAX_LOOP_MS)) {
    return { error: `Loop interval must be between 30s and 1d.` };
  }
  return intervalMs === undefined ? { prompt } : { prompt, intervalMs };
}

export function clampDelayMs(seconds: number): number {
  return Math.min(MAX_LOOP_MS, Math.max(MIN_LOOP_MS, Math.round(seconds * 1000)));
}

/** Active loops for a session from the branch's `pstack-loop` entries, with the last scheduled wake. */
export function loopsFromBranch(entries: readonly any[], sessionId: string): { loop: Loop; nextAt?: number }[] {
  const live = new Map<string, { loop: Loop; nextAt?: number }>();
  for (const e of entries) {
    if (e?.type !== "custom" || e.customType !== LOOP_ENTRY || !e.data) continue;
    const d = e.data as LoopEntry;
    if (d.op === "add" && d.loop.sessionId === sessionId) live.set(d.loop.id, { loop: d.loop });
    else if (d.op === "stop") live.delete(d.id);
    else if (d.op === "schedule") {
      const cur = live.get(d.id);
      if (cur) cur.nextAt = d.nextAt;
    }
  }
  return [...live.values()];
}

export function formatInterval(ms: number | undefined): string {
  if (ms === undefined) return "dynamic";
  for (const [u, n] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    if (ms % n === 0) return `${ms / n}${u}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
