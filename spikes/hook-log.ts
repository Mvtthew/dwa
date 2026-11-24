// Spike helper: a Claude Code command hook (and statusline command) that appends what it
// receives to spikes/out/events.jsonl. Usage in settings: `bun spikes/hook-log.ts <label>`.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2] ?? "unknown";
const outDir = process.env.DWA_SPIKE_OUT ?? join(import.meta.dir, "out");
const agent = process.env.DWA_AGENT_ID ?? "?";
mkdirSync(outDir, { recursive: true });

const raw = await Bun.stdin.text();
let input: unknown = raw;
try {
  input = JSON.parse(raw);
} catch {
  // keep the raw text
}

const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
if (socket && token) {
  // Kept out of the event log: the token is a credential for this session's inbox.
  writeFileSync(join(outDir, `inbox-${agent}.json`), JSON.stringify({ socket, token }), {
    mode: 0o600,
  });
}

appendFileSync(
  join(outDir, "events.jsonl"),
  `${JSON.stringify({ t: new Date().toISOString(), agent, label, socket, hasToken: Boolean(token), input })}\n`,
);

if (label === "statusline") {
  const data = input as { context_window?: { used_percentage?: number } };
  console.log(`dwa spike ${agent} ctx ${data.context_window?.used_percentage ?? "?"}%`);
}
