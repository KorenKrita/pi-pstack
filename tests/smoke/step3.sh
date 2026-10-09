#!/usr/bin/env bash
# Step 3 smoke: the local Task runtime against real headless Pi. Assertions come from JSON events and
# the task store under a temp PSTACK_HOME, not from the model's prose.
# Usage: tests/smoke/step3.sh [model]   (default local-openai/glm-5.3-flash)
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL="${1:-local-openai/glm-5.3-flash}"
OUT="tests/smoke/out/$(date +%Y%m%d-%H%M%S)-step3"
mkdir -p "$OUT"
export PSTACK_HOME="$(mktemp -d)"
echo "PSTACK_HOME=$PSTACK_HOME"
echo "transcripts: $OUT"

# Fixture config: every role on the parent model.
mkdir -p "$PSTACK_HOME/rules"
bun -e '
import { ROLES, serializeModelsRule } from "./extensions/pstack/config";
const roles = Object.fromEntries(ROLES.map((r) => [r.name, r.panel ? ["inherit-parent"] : "inherit-parent"]));
await Bun.write(process.env.PSTACK_HOME + "/rules/pstack-models.mdc", serializeModelsRule(roles, "unlimited"));
'

pi_json() {
	pi --no-extensions -e ./extensions/pstack/index.ts --no-context-files --no-skills --skill ./skills \
		--no-session --model "$MODEL" --mode json -p "/pstack on" "$@"
}

FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
check() { # check <label> <jq-filter-returning-bool> <file>
	if [ "$(jq -s "$2" "$3")" = "true" ]; then pass "$1"; else fail "$1"; fi
}
ENDS='[.[] | select(.type=="tool_execution_end")]'
meta_of() { jq -r "$1" "$PSTACK_HOME"/tasks/*/meta.json; }

# 1. Foreground Task returns the child's final text.
F1="$OUT/1-foreground.jsonl"
pi_json 'Call the Task tool exactly once with description "fg" and prompt "Reply with exactly the word PAPAYA-7 and nothing else." Then reply with the Task result only.' >"$F1" 2>"$OUT/1.err"
check "foreground Task result is the child's final text" \
	"$ENDS | map(select(.toolName==\"Task\")) | length == 1 and (.[0].isError | not) and (.[0].result.content[0].text | test(\"PAPAYA-7\"))" "$F1"

# 1b. A brief that starts like a CLI option reaches the child verbatim (prompt goes on stdin).
F1B="$OUT/1b-dash-prompt.jsonl"
pi_json 'Call the Task tool exactly once with description "dash" and prompt exactly "- Reply with exactly the word GUAVA-2 and nothing else." Then reply with the Task result only.' >"$F1B" 2>"$OUT/1b.err"
check "dash-leading prompt is delivered, not parsed as an option" \
	"$ENDS | map(select(.toolName==\"Task\")) | .[0] | (.isError | not) and (.result.content[0].text | test(\"GUAVA-2\"))" "$F1B"

# 2. Background Task returns at once; TaskOutput wait gets the result.
F2="$OUT/2-background.jsonl"
pi_json 'Call the Task tool exactly once with description "bg", run_in_background true, and prompt "Reply with exactly the word MANGO-3 and nothing else." Then call TaskOutput with that taskId and wait true. Then reply DONE.' >"$F2" 2>"$OUT/2.err"
check "background Task returns a taskId and status running" \
	"$ENDS | map(select(.toolName==\"Task\")) | .[0] | (.isError | not) and (.result.content[0].text | test(\"taskId: t[a-z0-9]+\") and test(\"running in background\"))" "$F2"
check "TaskOutput wait returns the background result" \
	"$ENDS | map(select(.toolName==\"TaskOutput\")) | last | (.isError | not) and (.result.content[0].text | test(\"MANGO-3\"))" "$F2"

# 3. Resume keeps the child's conversation.
F3="$OUT/3-resume.jsonl"
pi_json 'Call the Task tool with description "mem" and prompt "Remember the codeword KIWI-91. Reply only OK." Then call the Task tool again with description "mem", the same taskId as resume, and prompt "What was the codeword? Reply with it only." Then reply DONE.' >"$F3" 2>"$OUT/3.err"
check "resumed Task recalls the codeword from its own session" \
	"$ENDS | map(select(.toolName==\"Task\")) | length == 2 and (.[1].isError | not) and (.[1].result.content[0].text | test(\"KIWI-91\"))" "$F3"
RESUMED=$(jq -sr "$ENDS | map(select(.toolName==\"Task\")) | .[1].result.details.taskId // empty" "$F3")
if [ -n "$RESUMED" ] && [ "$(jq -r .runs "$PSTACK_HOME/tasks/$RESUMED/meta.json")" = "2" ]; then pass "resume reused the same task (runs=2)"; else fail "resume reused the same task (runs=2)"; fi

# 4. Nesting: depth-1 child spawns a depth-2 grandchild; the grandchild cannot spawn.
F4="$OUT/4-nested.jsonl"
pi_json 'Call the Task tool exactly once with description "outer" and this prompt: "Call the Task tool exactly once with description inner and prompt: Call the Task tool with description deepest and prompt hello. If the tool returns an error, reply with the exact error text. Otherwise reply with its result. Then reply with the inner result verbatim." Then reply with the Task result verbatim.' >"$F4" 2>"$OUT/4.err"
DEPTHS=$(jq -s 'map(.depth) | sort' "$PSTACK_HOME"/tasks/*/meta.json | jq -c .)
echo "      task depths: $DEPTHS"
if jq -e 'index(1) and index(2) and (index(3) | not)' <<<"$DEPTHS" >/dev/null; then pass "nested Tasks reach depth 2 and stop there"; else fail "nested Tasks reach depth 2 and stop there"; fi
INNER=$(jq -sr '.[] | select(.depth==2) | .id' "$PSTACK_HOME"/tasks/*/meta.json | head -1)
if [ -n "$INNER" ] && grep -q 'nesting limit' "$PSTACK_HOME/tasks/$INNER/events.jsonl"; then pass "depth-2 child got the nesting-limit error"; else fail "depth-2 child got the nesting-limit error"; fi

echo "--- tasks"
jq -c '{id, depth, description, status, runs, model, error}' "$PSTACK_HOME"/tasks/*/meta.json | tee "$OUT/tasks.txt"
cp -R "$PSTACK_HOME/tasks" "$OUT/store"
exit $FAIL
