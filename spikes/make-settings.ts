// Spike helper: writes spikes/out/settings.json, the per-session settings passed with --settings.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "out");
const hookScript = join(import.meta.dir, "hook-log.ts");
const bun = process.execPath;
mkdirSync(outDir, { recursive: true });

const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "SessionEnd",
];

const hooks = Object.fromEntries(
  events.map((event) => [
    event,
    [{ hooks: [{ type: "command", command: `${bun} ${hookScript} ${event}` }] }],
  ]),
);

// S3: a mailbox waiter armed at session start and re-armed after every turn.
const waiter = {
  type: "command",
  command: `${bun} ${join(import.meta.dir, "wait-mail.ts")}`,
  asyncRewake: true,
  timeout: 86400,
};
for (const event of ["SessionStart", "Stop"]) {
  (hooks[event] as { hooks: unknown[] }[])[0]?.hooks.push(waiter);
}

const settings = {
  hooks,
  statusLine: { type: "command", command: `${bun} ${hookScript} statusline` },
  crossSessionInbound: "accept",
};

const path = join(outDir, "settings.json");
writeFileSync(path, JSON.stringify(settings, null, 2));
console.log(path);
