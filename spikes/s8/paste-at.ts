// Spike S8: pastes a prompt into a session a set time after one of its MCP servers connected.
// Waits until the server has connected (see connectedAt), then, <gap-ms> after that moment, runs `paste-buffer -p` and presses Enter 300 ms later.
// Usage: bun paste-at.ts <tag> <gap-ms> <text> [server]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [tag, gap, text, serverName = "probe"] = process.argv.slice(2) as [
  string,
  string,
  string,
  string?,
];
const out = join(import.meta.dir, "..", "out", "s8");
const sid = readFileSync(join(out, `${tag}.sid`), "utf8").trim();
const project = join(import.meta.dir, "..", "out", "s5proj").replace(/[^A-Za-z0-9]/g, "-");
const logDir = join(
  process.env.HOME as string,
  "Library/Caches/claude-cli-nodejs",
  project,
  `mcp-logs-${serverName}`,
);
const tmux = (...args: string[]) => Bun.spawnSync([join(import.meta.dir, "t.sh"), ...args]);

// `probe` writes the time of the handshake into <tag>.connected (see probe-mcp.ts). The MCP log is
// the fallback for other servers; it is written about a second after the connection.
function connectedAt(): number | undefined {
  const marker = join(out, `${tag}.connected`);
  if (serverName === "probe")
    return existsSync(marker) ? Number(readFileSync(marker, "utf8")) || undefined : undefined;
  if (!existsSync(logDir)) return undefined;
  for (const file of readdirSync(logDir).sort().slice(-40)) {
    const body = readFileSync(join(logDir, file), "utf8");
    if (!body.includes(sid)) continue;
    for (const line of body.split("\n")) {
      if (line.includes("Successfully connected") && line.includes(sid))
        return Date.parse(JSON.parse(line).timestamp);
    }
  }
  return undefined;
}

const deadline = Date.now() + 60_000;
let at = connectedAt();
while (at === undefined && Date.now() < deadline) {
  await Bun.sleep(2);
  at = connectedAt();
}
if (at === undefined) throw new Error("the server did not connect");
const seen = Date.now() - at;
await Bun.write(join(out, `${tag}.paste.txt`), text);
tmux("load-buffer", "-b", `s8-${tag}`, join(out, `${tag}.paste.txt`));
await Bun.sleep(Math.max(0, at + Number(gap) - Date.now()));
const pasted = Date.now() - at;
tmux("paste-buffer", "-p", "-d", "-b", `s8-${tag}`, "-t", `s8:${tag}`);
await Bun.sleep(300);
tmux("send-keys", "-t", `s8:${tag}`, "Enter");
console.log(
  `${tag}: seen ${seen} ms after the connection, pasted at ${pasted} ms, Enter at ${Date.now() - at} ms`,
);
