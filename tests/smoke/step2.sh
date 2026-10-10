#!/usr/bin/env bash
# Step 2 smoke: real headless Pi (--mode json) with only this extension. Asserts from JSON events
# (system-message tool sets, tool_execution_end results), not from the model's replies.
# Not part of `bun test`. Interactive UI (AskQuestion, setup confirmation) is NOT exercised here;
# it is covered by the fake-UI unit tests in tests/extension.test.ts.
# Usage: tests/smoke/step2.sh [model]   (default local-openai/glm-5.3-flash)
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL="${1:-local-openai/glm-5.3-flash}"
OUT="tests/smoke/out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
export PSTACK_HOME="$(mktemp -d)"
echo "PSTACK_HOME=$PSTACK_HOME"
echo "transcripts: $OUT"

pi_json() {
	pi --no-extensions -e ./extensions/pstack/index.ts --no-context-files --no-skills --skill ./skills \
		--no-session --model "$MODEL" --mode json -p "$@"
}

FAIL=0
check() { # check <label> <jq-filter-returning-bool> <file>
	if [ "$(jq -s "$2" "$3")" = "true" ]; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=1; fi
}

# Roles for the fixture config (panel roles take lists).
ROLES_JSON=$(jq -nc --arg m "$MODEL" '{
	"feature, refactoring": $m, "bug-fix": $m, "perf-issue": $m, "hillclimb": $m,
	"judgment and prose": "inherit-parent", "hardest tasks": "inherit-parent",
	"how explorer": $m, "how explainer": "inherit-parent",
	"why investigators": $m, "why synthesizer": "inherit-parent",
	"reflect tooling": "auto", "reflect judgment, divergent, synthesizer": "inherit-parent",
	"arena runners": [$m, "inherit-parent"], "arena cross-judge pool": [$m],
	"swarm workers": $m, "architect runners": [$m, "inherit-parent"],
	"interrogate reviewers": [$m, "auto"]
}')

F="$OUT/session.jsonl"
pi_json \
	"Reply with just OK." \
	'/skill:pstack-how Ignore the skill steps. Call the Task tool exactly once with description "smoke" and prompt "noop". Then reply DONE.' \
	"Call the pstack_config tool exactly once with action \"write\", budget \"unlimited\", and roles exactly this JSON object: $ROLES_JSON . Then reply DONE." \
	'Call the Task tool exactly once with description "smoke" and prompt "noop" and model "nosuch/model-x". Then reply DONE.' \
	>"$F" 2>"$OUT/stderr.log"

OWN='["Task","AskQuestion","pstack_config"]'
# Cumulative tool set at each system message: added minus removed, in order.
SETS='[foreach (.[] | select(.type=="message_start" and .message.role=="system") | .message) as $m
	([]; (. + [$m.toolsAdded[]?.name]) - [$m.toolsRemoved[]? | if type=="string" then . else .name end]; .)]'
ENDS='[.[] | select(.type=="tool_execution_end")]'

check "no pstack tools before activation (first system message)" \
	"($SETS | .[0]) as \$s | ($OWN | all(. as \$t | \$s | index(\$t) | not))" "$F"
# Tool set in effect when the /skill:pstack-how turn's Task call ran: the last system message before that call.
check "pstack tools present for the /skill:pstack-how turn (before its Task call)" \
	"([.[] | select((.type==\"message_start\" and .message.role==\"system\") or (.type==\"tool_execution_start\" and .toolName==\"Task\"))]
	  | (map(.type==\"tool_execution_start\") | index(true)) as \$i | .[:\$i] | map(.message)
	  | reduce .[] as \$m ([]; (. + [\$m.toolsAdded[]?.name]) - [\$m.toolsRemoved[]? | if type==\"string\" then . else .name end]))
	 as \$s | ($OWN | all(. as \$t | \$s | index(\$t)))" "$F"
# System messages carry section deltas, so check "first seen" rather than "present in the last one".
SECS='[.[] | select(.type=="message_start" and .message.role=="system") | .message.sections // {} | keys]'
check "adapter note injected after activation, not before" \
	"$SECS | (.[0] | index(\"pstack_adapter\") | not) and (.[1:] | any(index(\"pstack_adapter\")))" "$F"
check "always-apply config rule injected after pstack_config write" \
	"$SECS | any(index(\"pstack_rules\"))" "$F"
check "no poteto reminder/grant for ordinary skill" \
	'[.[] | select(.type=="message_start" and .message.role=="system") | .message.sections // {} | has("pstack_mode")] | any | not' "$F"
check "Task without config -> setup error" \
	"$ENDS | map(select(.toolName==\"Task\")) | .[0] | .isError and (.result.content[0].text | startswith(\"pstack is not configured: run /setup-pstack\"))" "$F"
check "pstack_config write succeeds" \
	"$ENDS | map(select(.toolName==\"pstack_config\")) | last | (.isError | not) and (.result.content[0].text | startswith(\"Wrote \"))" "$F"
if [ -f "$PSTACK_HOME/rules/pstack-models.mdc" ]; then echo "PASS  config file written under PSTACK_HOME"; else echo "FAIL  config file written under PSTACK_HOME"; FAIL=1; fi
# Correlate by toolCallId: the Task call whose args named the unknown model.
check "Task with unknown model -> Unknown model + Available models, not the setup error" \
	"([.[] | select(.type==\"tool_execution_start\" and .toolName==\"Task\" and .args.model==\"nosuch/model-x\") | .toolCallId]) as \$ids
	 | (\$ids | length) == 1 and ($ENDS | map(select(.toolCallId == \$ids[0])) | .[0]
	 | .isError and (.result.content[0].text | (startswith(\"Unknown model \\\"nosuch/model-x\\\"\") and contains(\"Available models\") and contains(\"$MODEL\") and (contains(\"not configured\") | not))))" "$F"

echo "--- tool results"
jq -c 'select(.type=="tool_execution_end") | {tool: .toolName, isError, text: (.result.content[0].text | .[0:160])}' "$F" | tee "$OUT/summary.txt"
[ -f "$PSTACK_HOME/rules/pstack-models.mdc" ] && cp "$PSTACK_HOME/rules/pstack-models.mdc" "$OUT/"
exit $FAIL
