#!/usr/bin/env bash
# Step 2 smoke (review item 9): the extension command `/how <args>` must reach the model as the exact
# same user message as Pi's own `/skill:how <args>` expansion. Uses RPC mode, because in -p/json mode an
# extension command's sendUserMessage is fire-and-forget and no turn runs.
# Usage: tests/smoke/step2-forward.sh [model]   (default local-openai/glm-5.3-flash)
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL="${1:-local-openai/glm-5.3-flash}"
OUT="tests/smoke/out/$(date +%Y%m%d-%H%M%S)-forward"
mkdir -p "$OUT"
export PSTACK_HOME="$(mktemp -d)"

first_user_message() { # first_user_message <prompt> <out-file>
	{ jq -nc --arg m "$1" '{id:"1",type:"prompt",message:$m}'; sleep 25; } |
		pi --no-extensions -e ./extensions/pstack/index.ts --no-context-files --no-skills --skill ./skills \
			--no-session --model "$MODEL" --mode rpc 2>"$2.err" >"$2"
	jq -sc '[.[] | select(.type=="message_start" and .message.role=="user")][0].message.content
		| if type=="string" then . else map(.text // "") | join("") end' "$2"
}

A=$(first_user_message "/how ARGX1 reply OK only" "$OUT/how.jsonl")
B=$(first_user_message "/skill:how ARGX1 reply OK only" "$OUT/skill-how.jsonl")
FAIL=0
if [ "$A" != "null" ] && [ "$A" = "$B" ]; then echo "PASS  /how forwards to the identical /skill:how block"; else echo "FAIL  /how vs /skill:how differ"; FAIL=1; fi
if printf '%s' "$A" | jq -e 'startswith("<skill name=\"how\"") and endswith("ARGX1 reply OK only")' >/dev/null; then echo "PASS  block carries the skill and the arguments"; else echo "FAIL  block shape"; FAIL=1; fi
exit $FAIL
