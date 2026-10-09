// Minimal stdio MCP server (newline-delimited JSON-RPC) with one tool, for the MCP-parity acceptance run.
// Usage: bun fixture-mcp.ts <server-name>
const name = process.argv[2] ?? "fixture";
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue; // notification
    if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } });
    else if (msg.method === "tools/list") reply(msg.id, { tools: [{ name: "ping", description: `Reply with the ${name} marker.`, inputSchema: { type: "object", properties: {} } }] });
    else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: `PONG-${name}` }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }) + "\n");
  }
});
