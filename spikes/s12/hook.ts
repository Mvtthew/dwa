// Spike S12: a hook command that records its input in out/s12/hooks.jsonl. It prints nothing,
// except on PreToolUse of the tool named in out/s12/refuse.txt (read on every call), which it
// refuses the way `dwa hook` does.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "..", "out", "s12");
const input = JSON.parse(await Bun.stdin.text());
const file = join(out, "refuse.txt");
const refused =
  input.hook_event_name === "PreToolUse" &&
  existsSync(file) &&
  readFileSync(file, "utf8").trim() === input.tool_name;
appendFileSync(
  join(out, "hooks.jsonl"),
  `${JSON.stringify({ at: new Date().toISOString(), tag: process.argv[2] ?? "", refused, input })}\n`,
);
if (refused)
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "S12: this tool is switched off for this session.",
      },
    }),
  );
