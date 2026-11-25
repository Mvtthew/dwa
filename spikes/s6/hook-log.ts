// Spike S6: a hook command that appends what it was given to out/s6/hooks.jsonl.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(await Bun.stdin.text());
appendFileSync(
  join(import.meta.dir, "..", "out", "s6", "hooks.jsonl"),
  `${JSON.stringify({
    tag: process.argv[2] ?? "",
    event: input.hook_event_name,
    session_id: input.session_id,
    source: input.source,
    tool: input.tool_name,
    transcript: input.transcript_path,
  })}\n`,
);

// Live decisions: out/s6/decide.json maps a tool name to "deny" or "allow". Read on every call,
// so it can change while the session runs (the settings file itself is not re-read).
if (input.hook_event_name === "PreToolUse") {
  const file = Bun.file(join(import.meta.dir, "..", "out", "s6", "decide.json"));
  const decide: Record<string, string> = (await file.exists()) ? await file.json() : {};
  const decision = decide[input.tool_name];
  if (decision) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: `S6: ${input.tool_name} is set to ${decision} for this session`,
        },
      }),
    );
  }
}
