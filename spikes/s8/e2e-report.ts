// Spike S8, end-to-end check: the timeline of one dwa session in a scratch project, from the
// project's store (read-only), the session's transcript and Claude Code's MCP logs.
// Usage: bun e2e-report.ts <project-dir> <agent-name> [session-id]
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [projectDir, name, wanted] = process.argv.slice(2) as [string, string, string?];
const db = new Database(join(projectDir, ".dwa/run/dwa.sqlite"), { readonly: true });
type Row = Record<string, string | number | null>;
const all = db.query("SELECT * FROM agents WHERE name = ? ORDER BY created_at").all(name) as Row[];
const row = (wanted ? all.find((r) => r.session_id === wanted) : all.at(-1)) as Row;
const sid = row.session_id as string;
const project = projectDir.replace(/[^A-Za-z0-9]/g, "-");
const home = process.env.HOME as string;
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const rows: { at: number; text: string }[] = [];
const t0 = row.created_at as number;
rows.push({ at: t0, text: "store     row created" });
if (row.stopped_at) rows.push({ at: row.stopped_at as number, text: "store     stopped_at" });
if (row.finished_at) rows.push({ at: row.finished_at as number, text: "store     finished_at" });

const cache = join(home, "Library/Caches/claude-cli-nodejs", project);
for (const dir of existsSync(cache)
  ? readdirSync(cache).filter((d) => d.startsWith("mcp-logs-"))
  : []) {
  for (const file of readdirSync(join(cache, dir)).slice(-80)) {
    for (const rec of lines(join(cache, dir, file))) {
      if (rec.sessionId !== sid) continue;
      if (/^(Starting connection|Successfully connected|Calling MCP tool)/.test(rec.debug ?? ""))
        rows.push({
          at: Date.parse(rec.timestamp),
          text: `mcp-log   ${dir.slice(9)}: ${rec.debug}`,
        });
    }
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
const short = (names: string[] = []) => {
  const mcp = names.filter((n) => n.startsWith("mcp__") && !n.startsWith("mcp__easel"));
  const servers = [...new Set(mcp.map((n) => n.split("__")[1]))];
  return (
    servers.map((s) => `${s}:${mcp.filter((n) => n.split("__")[1] === s).length}`).join(",") || "-"
  );
};
for (const rec of records) {
  const at = Date.parse(rec.timestamp);
  if (rec.type === "api-request") {
    const tools = shapes.get(rec.shapeHash) ?? [];
    const builtin = tools.filter((n) => !n.startsWith("mcp__")).join(",");
    rows.push({ at, text: `REQUEST   mcp-in-tools=${short(tools)} builtin=${builtin}` });
  } else if (rec.attachment?.type === "deferred_tools_delta") {
    const a = rec.attachment;
    rows.push({
      at,
      text: `delta     added-mcp=${short(a.addedNames)} (+${a.addedNames?.length ?? 0}) pending=${JSON.stringify(a.pendingMcpServers)} toolSearchAbsent=${a.toolSearchAbsent}`,
    });
  } else if (rec.type === "assistant") {
    for (const part of rec.message?.content ?? []) {
      if (part.type === "tool_use")
        rows.push({
          at,
          text: `tool_use  ${part.name} ${JSON.stringify(part.input).slice(0, 90)}`,
        });
      if (part.type === "text")
        rows.push({ at, text: `assistant ${JSON.stringify(part.text.slice(0, 140))}` });
    }
  } else if (rec.type === "user" && !rec.isSidechain) {
    const content = rec.message?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    rows.push({ at, text: `user      ${JSON.stringify(text.slice(0, 150))}` });
  }
}
rows.sort((a, b) => a.at - b.at);
console.log(
  `# ${name} session ${sid} state=${row.state} had_turn=${row.had_turn} spawned_by=${row.spawned_by} task=${JSON.stringify(row.task)}`,
);
const launch = JSON.parse((row.launch as string) ?? "null");
console.log(`# stored launch: ${JSON.stringify(launch).slice(0, 700)}`);
for (const r of rows)
  console.log(
    `${new Date(r.at).toISOString().slice(11, 23)} ${((r.at - t0) / 1000).toFixed(2).padStart(7)}s  ${r.text}`,
  );
