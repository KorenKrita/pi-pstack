#!/usr/bin/env bun
// Fake `pi --mode json -p` for Task runtime tests. Behaviour comes from the prompt (stdin):
//   "echo:<text>"  reply <text>          "args"   reply JSON {args, env}
//   "sleep:<ms>"   wait, then reply done  "fail"   exit 3 with stderr
//   "error"        assistant stopReason error   "empty"  no assistant text
//   "ignore-term"  ignore SIGTERM and hang (shutdown escalation check)
//   "remember"     reply with the count of prior runs in --session-dir (resume check)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
// Like real `pi -p` with no message argument: the prompt arrives on stdin.
const prompt = (await Bun.stdin.text()).trim();
const sessionDir = args[args.indexOf("--session-dir") + 1]!;
mkdirSync(sessionDir, { recursive: true });
const log = join(sessionDir, "fake.log");
const prior = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
if (args.includes("-c") === false && prior.length) prior.length = 0;
appendFileSync(log, prompt + "\n");

const emit = (e: unknown) => process.stdout.write(JSON.stringify(e) + "\n");
const reply = (text: string, stopReason = "stop", extra: object = {}) =>
  emit({
    type: "message_end",
    message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, usage: { input: 10, output: 5, cost: { total: 0.001 } }, ...extra },
  });

emit({ type: "session", version: 3 });
emit({ type: "tool_execution_start", toolName: "read" });
if (prompt.startsWith("echo:")) reply(prompt.slice(5));
else if (prompt === "args") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PSTACK_")));
  reply(JSON.stringify({ args, env, cwd: process.cwd() }));
} else if (prompt.startsWith("sleep:")) {
  reply("working");
  await Bun.sleep(Number(prompt.slice(6)));
  reply("done");
} else if (prompt === "fail") {
  process.stderr.write("boom\n");
  process.exit(3);
} else if (prompt === "error") reply("", "error", { errorMessage: "upstream 502" });
else if (prompt === "empty") reply("");
else if (prompt === "ignore-term") {
  process.on("SIGTERM", () => {});
  reply("stubborn");
  await Bun.sleep(60_000);
} else if (prompt === "remember") reply(`prior=${prior.length} first=${prior[0] ?? ""}`);
else reply(`unknown fake prompt: ${prompt}`);
