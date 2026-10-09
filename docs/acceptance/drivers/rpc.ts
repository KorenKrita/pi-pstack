// Minimal RPC driver for acceptance runs. Usage (library): import { start } from "./rpc.ts".
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Rec = Record<string, any>;
export type UiAnswer = (req: Rec) => Rec | undefined; // returns response body fields ({value}|{confirmed}|{cancelled})

export function start(opts: { cwd: string; runDir: string; args?: string[]; ui?: UiAnswer }) {
  mkdirSync(opts.runDir, { recursive: true });
  const log = join(opts.runDir, "events.jsonl");
  const child = spawn("pi", ["--mode", "rpc", ...(opts.args ?? [])], { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const records: Rec[] = [];
  const waiters: { pred: (r: Rec) => boolean; resolve: (r: Rec) => void }[] = [];
  let buf = "";
  let seq = 0;
  child.stderr.on("data", (d) => appendFileSync(join(opts.runDir, "stderr.log"), d));
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let rec: Rec;
      try { rec = JSON.parse(line); } catch { appendFileSync(log, JSON.stringify({ _badline: line }) + "\n"); continue; }
      rec._t = Date.now();
      records.push(rec);
      // keep the log small: drop streaming deltas
      if (rec.type !== "message_update") appendFileSync(log, JSON.stringify(rec) + "\n");
      if (rec.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(rec.method)) {
        const body = opts.ui?.(rec) ?? { cancelled: true };
        appendFileSync(log, JSON.stringify({ _ui_answer: rec.id, ...body, _t: Date.now() }) + "\n");
        send({ type: "extension_ui_response", id: rec.id, ...body });
      }
      for (const w of [...waiters]) if (w.pred(rec)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(rec); }
    }
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  function send(cmd: Rec) {
    appendFileSync(log, JSON.stringify({ _sent: cmd, _t: Date.now() }) + "\n");
    child.stdin.write(JSON.stringify(cmd) + "\n");
  }
  function waitFor(pred: (r: Rec) => boolean, timeoutMs: number, label = "event"): Promise<Rec> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      waiters.push({ pred, resolve: (r) => { clearTimeout(t); resolve(r); } });
    });
  }
  async function request(cmd: Rec, timeoutMs = 60_000): Promise<Rec> {
    const id = `d${++seq}`;
    const p = waitFor((r) => r.type === "response" && r.id === id, timeoutMs, `response ${cmd.type}`);
    send({ ...cmd, id });
    const r = await p;
    if (!r.success) throw new Error(`${cmd.type} failed: ${r.error}`);
    return r;
  }
  /** Send a prompt and wait until agent_settled (or response disposition handled). */
  async function prompt(message: string, timeoutMs = 600_000): Promise<Rec> {
    const startIdx = records.length;
    const settled = waitFor((r) => r.type === "agent_settled", timeoutMs, `agent_settled for ${message.slice(0, 40)}`);
    const r = await request({ type: "prompt", message });
    if (r.data?.disposition === "handled") {
      // An extension command may start its own run (sendUserMessage); wait for it if one begins.
      await new Promise((res) => setTimeout(res, 1500));
      if (!records.slice(startIdx).some((x) => x.type === "agent_start")) { settled.catch(() => {}); return r; }
    }
    await settled;
    return r;
  }
  async function close() {
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGTERM"), 20_000);
    const code = await exited;
    clearTimeout(t);
    return code;
  }
  return { child, records, send, waitFor, request, prompt, close, exited, log };
}

export function toolStarts(records: Rec[], name?: string) {
  return records.filter((r) => r.type === "tool_execution_start" && (!name || r.toolName === name));
}
export function toolEnds(records: Rec[], name?: string) {
  return records.filter((r) => r.type === "tool_execution_end" && (!name || r.toolName === name));
}

export const results: { name: string; pass: boolean; detail: string }[] = [];
export function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
