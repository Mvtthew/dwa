// Spike S6: writes a session settings file. Usage: bun settings.ts <out-file> <tag> '<json to merge into permissions etc.>'
import { join } from "node:path";

const [file, tag, extra] = process.argv.slice(2);
const hook = `${process.execPath} ${join(import.meta.dir, "hook-log.ts")} ${tag}`;
const entry = [{ hooks: [{ type: "command", command: hook }] }];
const settings = {
  hooks: { SessionStart: entry, Stop: entry, PreToolUse: entry, SessionEnd: entry },
  claudeMdExcludes: [`${process.env.HOME}/.claude/CLAUDE.md`],
  autoMemoryEnabled: false,
  permissions: { allow: ["mcp__dwa"] },
  ...JSON.parse(extra ?? "{}"),
};
await Bun.write(file as string, `${JSON.stringify(settings, null, 2)}\n`);
