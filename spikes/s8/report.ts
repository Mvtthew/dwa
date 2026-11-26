// Spike S8: prints the timeline of a session from its transcript and the MCP log of `probe`:
// when the server connected, every API request (seconds after the connection, whether the model
// had mcp__probe__ping by then), deferred-tool notices, tool calls and replies.
// A late tool is not put into the request's `tools`: it is announced in the conversation by a
// `deferred_tools_delta` attachment (sent as a `tool_addition` block). So "ping" is "tools" when
// the request's tool list has it, "delta" when such an attachment came before the request.
// Usage: bun report.ts <tag> [server]   (default server: probe; times are relative to its connection)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tag = process.argv[2] as string;
const serverName = process.argv[3] ?? "probe";
const ping = `mcp__${serverName}__ping`;
const out = join(import.meta.dir, "..", "out", "s8");
const sid = readFileSync(join(out, `${tag}.sid`), "utf8").trim();
const project = join(import.meta.dir, "..", "out", "s5proj").replace(/[^A-Za-z0-9]/g, "-");
const home = process.env.HOME as string;
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

let connected: number | undefined;
const rows: { at: number; text: string }[] = [];
const logDir = join(home, "Library/Caches/claude-cli-nodejs", project, `mcp-logs-${serverName}`);
for (const file of existsSync(logDir) ? readdirSync(logDir) : []) {
  for (const rec of lines(join(logDir, file))) {
    if (rec.sessionId !== sid) continue;
    const at = Date.parse(rec.timestamp);
    if (/^Successfully connected/.test(rec.debug ?? "")) connected ??= at;
    if (/^(Starting connection|Successfully connected|Calling MCP tool)/.test(rec.debug ?? ""))
      rows.push({ at, text: `mcp-log   ${rec.debug}` });
  }
}

const records = lines(join(home, ".claude/projects", project, `${sid}.jsonl`));
const shapes = new Map<string, string[]>();
for (const rec of records)
  if (rec.type === "api-request-shape")
    shapes.set(
      rec.shapeHash,
      rec.shape.tools.map((tool: { name: string }) => tool.name),
    );
let version = "";
let announced = false;
for (const rec of records) {
  const at = Date.parse(rec.timestamp);
  version ||= rec.version ?? "";
  if (rec.type === "api-request") {
    const tools = shapes.get(rec.shapeHash) ?? [];
    const has = tools.includes(ping) ? "tools" : announced ? "delta" : "";
    const search = tools.includes("ToolSearch");
    rows.push({
      at,
      text: `REQUEST   ping=${has ? `YES(${has})` : "no"} toolsearch=${search ? "yes" : "no"} tools=${tools.length} source=${rec.querySource} shape=${rec.shapeHash.slice(0, 8)}`,
    });
  } else if (rec.attachment?.type === "deferred_tools_delta") {
    const a = rec.attachment;
    if (a.addedNames?.includes(ping)) announced = true;
    rows.push({
      at,
      text: `delta     added=${JSON.stringify(a.addedNames?.filter((n: string) => n.startsWith("mcp__")))} (+${a.addedNames?.length ?? 0}) pending=${JSON.stringify(a.pendingMcpServers)} toolSearchAbsent=${a.toolSearchAbsent}`,
    });
  } else if (rec.type === "assistant") {
    for (const part of rec.message?.content ?? []) {
      if (part.type === "tool_use")
        rows.push({
          at,
          text: `tool_use  ${part.name} ${JSON.stringify(part.input).slice(0, 80)}`,
        });
      if (part.type === "text")
        rows.push({ at, text: `assistant ${JSON.stringify(part.text.slice(0, 100))}` });
    }
  } else if (rec.type === "user" && !rec.isSidechain) {
    const content = rec.message?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    rows.push({ at, text: `user      ${text.slice(0, 110)}` });
  } else if (rec.type === "attachment" && /hook/.test(rec.attachment?.type ?? "")) {
    rows.push({
      at,
      text: `attach    ${rec.attachment.type} ${JSON.stringify(rec.attachment).slice(0, 110)}`,
    });
  }
}
rows.sort((a, b) => a.at - b.at);
console.log(`# ${tag} session ${sid} version ${version}`);
for (const row of rows) {
  const rel =
    connected === undefined ? "    ?" : ((row.at - connected) / 1000).toFixed(2).padStart(7);
  console.log(`${new Date(row.at).toISOString().slice(11, 23)} ${rel}s  ${row.text}`);
}
