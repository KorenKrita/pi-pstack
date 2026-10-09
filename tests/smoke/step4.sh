#!/usr/bin/env bash
# Step 4 smoke: long-run features against real Pi in RPC mode (idle wake-ups need a live session).
# Assertions come from RPC events and session entries, not from the model's prose.
#   1. A background Task's completion wakes the idle parent (no TaskOutput call).
#   2. /goal keeps the agent going across runs until it calls GoalDone.
#   3. /loop 30s ticks at least twice, then /loop stop: no further tick.
# Usage: tests/smoke/step4.sh [model]   (default local-openai/glm-5.3-flash). Takes ~3 minutes.
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL="${1:-local-openai/glm-5.3-flash}"
OUT="tests/smoke/out/$(date +%Y%m%d-%H%M%S)-step4"
mkdir -p "$OUT"
export PSTACK_HOME="$(mktemp -d)"
echo "PSTACK_HOME=$PSTACK_HOME"
echo "transcripts: $OUT"

mkdir -p "$PSTACK_HOME/rules"
bun -e '
import { ROLES, serializeModelsRule } from "./extensions/pstack/config";
const roles = Object.fromEntries(ROLES.map((r) => [r.name, r.panel ? ["inherit-parent"] : "inherit-parent"]));
await Bun.write(process.env.PSTACK_HOME + "/rules/pstack-models.mdc", serializeModelsRule(roles, "unlimited"));
'

FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# rpc_session <out> <script>: runs one RPC Pi; <script> is a list of lines "send <json-message>" or "sleep <s>".
rpc_session() {
	local out="$1" script="$2"
	{
		local n=0
		while IFS= read -r line; do
			case "$line" in
				send\ *) n=$((n + 1)); jq -nc --arg id "$n" --arg m "${line#send }" '{id:$id,type:"prompt",message:$m}' ;;
				sleep\ *) sleep "${line#sleep }" ;;
			esac
		done <<<"$script"
	} | pi --no-extensions -e ./extensions/pstack/index.ts --no-context-files --no-skills --skill ./skills \
		--session-dir "$OUT/sessions" --model "$MODEL" --mode rpc >"$out" 2>"$out.err" || true
}

# 1. Background completion wakes the parent.
S1="$OUT/1-notify.jsonl"
rpc_session "$S1" "send /pstack on
sleep 3
send Call the Task tool exactly once with description \"bg\", run_in_background true, and prompt \"Reply with exactly the word PLUM-5 and nothing else.\" Then reply WAITING and stop. Do not call TaskOutput.
sleep 90"
AGENT_STARTS=$(jq -s '[.[] | select(.type=="agent_start")] | length' "$S1")
NOTIFIED=$(jq -s '[.[] | select(.type=="message_start" and .message.customType=="pstack-task-done")] | length' "$S1")
TASKOUT=$(jq -s '[.[] | select(.type=="tool_execution_end" and .toolName=="TaskOutput")] | length' "$S1")
echo "      agent runs: $AGENT_STARTS, task-done messages: $NOTIFIED, TaskOutput calls: $TASKOUT"
if [ "$NOTIFIED" = "1" ]; then pass "exactly one completion notification"; else fail "exactly one completion notification"; fi
if [ "$AGENT_STARTS" -ge 2 ]; then pass "the notification started a new run in the idle parent"; else fail "the notification started a new run in the idle parent"; fi
if jq -se '[.[] | select(.type=="message_start" and .message.customType=="pstack-task-done")][0].message.content | tostring | test("PLUM-5")' "$S1" >/dev/null; then pass "notification carries the result"; else fail "notification carries the result"; fi

# 2. /goal continues across runs until GoalDone.
S2="$OUT/2-goal.jsonl"
rpc_session "$S2" "send /goal Count to three across three separate replies: reply with only the next number (1, then 2, then 3), one number per reply, never more than one per reply. After you have replied 3, call GoalDone with summary \"counted\".
sleep 90"
S2_SESSION=$(grep -l '"pstack-goal"' "$OUT"/sessions/*.jsonl | head -1)
# Continuation entries are written by agent_before_settle straight into the session (no RPC message event).
CONT=$(jq -s '[.[] | select(.type=="custom_message" and .customType=="pstack-goal-continue")] | length' "$S2_SESSION")
RUNS=$(jq -s '[.[] | select(.type=="agent_start")] | length' "$S2")
DONE=$(jq -s '[.[] | select(.type=="tool_execution_end" and .toolName=="GoalDone" and (.isError | not))] | length' "$S2")
echo "      goal continuations: $CONT, agent runs: $RUNS, GoalDone calls: $DONE"
if [ "$CONT" -ge 1 ] && [ "$RUNS" -ge 2 ]; then pass "goal continued the agent after a normal end"; else fail "goal continued the agent after a normal end"; fi
if [ "$DONE" = "1" ]; then pass "goal finished with GoalDone"; else fail "goal finished with GoalDone"; fi
GOAL_STATE=$(jq -sr '[.[] | select(.type=="custom" and .customType=="pstack-goal")] | last | .data.status' "$S2_SESSION")
if [ "$GOAL_STATE" = "done" ]; then pass "goal entry ends as done"; else fail "goal entry ends as done (got $GOAL_STATE)"; fi

# 3. /loop ticks, then stops.
S3="$OUT/3-loop.jsonl"
rpc_session "$S3" "send /loop 30s Reply with only the word TICK.
sleep 70
send /loop stop
sleep 45"
TICKS=$(jq -s '[.[] | select(.type=="message_start" and .message.customType=="pstack-loop-tick")] | length' "$S3")
echo "      loop ticks: $TICKS"
if [ "$TICKS" -ge 2 ] && [ "$TICKS" -le 3 ]; then pass "loop ticked 2-3 times in 70s"; else fail "loop ticked 2-3 times in 70s"; fi
STOP_LINE=$(grep -n '"id":"2","type":"response"' "$S3" | head -1 | cut -d: -f1 || true)
AFTER=$(if [ -n "$STOP_LINE" ]; then tail -n +"$STOP_LINE" "$S3" | jq -s '[.[] | select(.type=="message_start" and .message.customType=="pstack-loop-tick")] | length'; else echo "?"; fi)
echo "      ticks after /loop stop: $AFTER"
if [ "$AFTER" = "0" ]; then pass "no tick after /loop stop"; else fail "no tick after /loop stop"; fi

cp -R "$PSTACK_HOME/tasks" "$OUT/store" 2>/dev/null || true
exit $FAIL
