// Spike S14: writes a session settings file. Usage: bun settings.ts <out-file> <tag> [deny-rule]
import { join } from "node:path";

const [file, tag, deny] = process.argv.slice(2);
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
    Stop: entry,
  },
  claudeMdExcludes: [`${process.env.HOME}/.claude/CLAUDE.md`],
  autoMemoryEnabled: false,
  permissions: { allow: ["Read", "Bash(ls *)"], deny: deny ? [deny] : [] },
};
await Bun.write(file as string, `${JSON.stringify(settings, null, 2)}\n`);
