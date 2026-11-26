// Spike S11: writes a session settings file. Usage: bun settings.ts <out-file> <tag>
import { join } from "node:path";

const [file, tag] = process.argv.slice(2);
const hook = `${process.execPath} ${join(import.meta.dir, "hook.ts")} ${tag}`;
const entry = [{ hooks: [{ type: "command", command: hook }] }];
const settings = {
  hooks: {
    SessionStart: entry,
    PreToolUse: entry,
    PostToolUse: entry,
    PostToolUseFailure: entry,
    Stop: entry,
  },
  claudeMdExcludes: [`${process.env.HOME}/.claude/CLAUDE.md`],
  autoMemoryEnabled: false,
  permissions: { allow: ["Read", "Bash(ls *)", "Bash(cat *)", "Bash(false)", "Bash(echo *)"] },
};
await Bun.write(file as string, `${JSON.stringify(settings, null, 2)}\n`);
