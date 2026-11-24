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
  "SubagentStop",
  "SessionEnd",
];

const hooks = Object.fromEntries(
  events.map((event) => [
    event,
    [{ hooks: [{ type: "command", command: `${bun} ${hookScript} ${event}` }] }],
  ]),
);

const settings = {
  hooks,
  statusLine: { type: "command", command: `${bun} ${hookScript} statusline` },
  crossSessionInbound: "accept",
};

const path = join(outDir, "settings.json");
writeFileSync(path, JSON.stringify(settings, null, 2));
console.log(path);
