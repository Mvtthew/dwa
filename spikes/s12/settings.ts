// Spike S12: writes a session settings file. Usage: [S12_DENY=rule,rule] bun settings.ts <out-file> <tag> [allow,rules]
import { join } from "node:path";

const [file, tag, allow] = process.argv.slice(2);
const hook = `${process.execPath} ${join(import.meta.dir, "hook.ts")} ${tag}`;
const entry = [{ hooks: [{ type: "command", command: hook }] }];
const settings = {
  hooks: {
    SessionStart: entry,
    PreToolUse: entry,
    PostToolUse: entry,
    PostToolUseFailure: entry,
    PermissionRequest: entry,
    PermissionDenied: entry,
    Notification: entry,
    Stop: entry,
  },
  claudeMdExcludes: [`${process.env.HOME}/.claude/CLAUDE.md`],
  autoMemoryEnabled: false,
  permissions: {
    allow: (allow ?? "").split(",").filter(Boolean),
    deny: (process.env.S12_DENY ?? "").split(",").filter(Boolean),
  },
};
await Bun.write(file as string, `${JSON.stringify(settings, null, 2)}\n`);
